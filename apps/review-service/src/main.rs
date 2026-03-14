use actix_web::{web, App, HttpServer, HttpResponse, middleware};
use actix_web_prom::PrometheusMetricsBuilder;
use chrono::Utc;
use futures_util::StreamExt;
use log::{info, error};
use mongodb::{
    bson::{doc, Document},
    options::{ClientOptions, FindOptions},
    Client, Collection,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Review {
    id: String,
    product_id: String,
    user_id: String,
    rating: u8,
    comment: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateReviewRequest {
    product_id: String,
    user_id: String,
    rating: u8,
    comment: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateReviewRequest {
    user_id: String,
    rating: u8,
    comment: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewQuery {
    product_id: Option<String>,
    page: Option<u64>,
    limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PaginationQuery {
    page: Option<u64>,
    limit: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PaginatedResponse {
    reviews: Vec<Review>,
    total: u64,
    page: u64,
    limit: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RatingStats {
    product_id: String,
    average_rating: f64,
    total_reviews: u64,
    distribution: HashMap<String, u64>,
}

#[derive(Clone)]
struct AppState {
    collection: Collection<Document>,
}

fn review_to_document(review: &Review) -> Document {
    doc! {
        "id": &review.id,
        "productId": &review.product_id,
        "userId": &review.user_id,
        "rating": review.rating as i32,
        "comment": &review.comment,
        "createdAt": &review.created_at,
        "updatedAt": &review.updated_at,
    }
}

fn document_to_review(doc: &Document) -> Result<Review, String> {
    Ok(Review {
        id: doc.get_str("id").map_err(|e| e.to_string())?.to_string(),
        product_id: doc.get_str("productId").map_err(|e| e.to_string())?.to_string(),
        user_id: doc.get_str("userId").map_err(|e| e.to_string())?.to_string(),
        rating: doc.get_i32("rating").map_err(|e| e.to_string())? as u8,
        comment: doc.get_str("comment").map_err(|e| e.to_string())?.to_string(),
        created_at: doc.get_str("createdAt").map_err(|e| e.to_string())?.to_string(),
        updated_at: doc.get_str("updatedAt").map_err(|e| e.to_string())?.to_string(),
    })
}

async fn create_review(
    state: web::Data<AppState>,
    body: web::Json<CreateReviewRequest>,
) -> HttpResponse {
    if body.rating < 1 || body.rating > 5 {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Rating must be between 1 and 5"
        }));
    }

    let existing = state
        .collection
        .find_one(
            doc! { "productId": &body.product_id, "userId": &body.user_id },
            None,
        )
        .await;

    match existing {
        Ok(Some(_)) => {
            return HttpResponse::Conflict().json(serde_json::json!({
                "error": "User has already reviewed this product"
            }));
        }
        Err(e) => {
            error!("Failed to check existing review: {}", e);
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to create review"
            }));
        }
        Ok(None) => {}
    }

    let now = Utc::now().to_rfc3339();
    let review = Review {
        id: Uuid::new_v4().to_string(),
        product_id: body.product_id.clone(),
        user_id: body.user_id.clone(),
        rating: body.rating,
        comment: body.comment.clone(),
        created_at: now.clone(),
        updated_at: now,
    };

    let document = review_to_document(&review);

    match state.collection.insert_one(document, None).await {
        Ok(_) => {
            info!("Created review {} for product {}", review.id, review.product_id);
            HttpResponse::Created().json(review)
        }
        Err(e) => {
            error!("Failed to create review: {}", e);
            HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to create review"
            }))
        }
    }
}

async fn list_reviews(
    state: web::Data<AppState>,
    query: web::Query<ReviewQuery>,
) -> HttpResponse {
    let filter = match &query.product_id {
        Some(pid) => doc! { "productId": pid },
        None => doc! {},
    };

    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(20).max(1);
    let skip = (page - 1) * limit;

    let total = match state.collection.count_documents(filter.clone(), None).await {
        Ok(count) => count,
        Err(e) => {
            error!("Failed to count reviews: {}", e);
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to query reviews"
            }));
        }
    };

    let find_options = FindOptions::builder()
        .skip(skip)
        .limit(limit as i64)
        .build();

    let cursor = match state.collection.find(filter, find_options).await {
        Ok(cursor) => cursor,
        Err(e) => {
            error!("Failed to query reviews: {}", e);
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to query reviews"
            }));
        }
    };

    let reviews = collect_reviews(cursor).await;

    HttpResponse::Ok().json(PaginatedResponse {
        reviews,
        total,
        page,
        limit,
    })
}

async fn get_review(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let review_id = path.into_inner();

    match state.collection.find_one(doc! { "id": &review_id }, None).await {
        Ok(Some(doc)) => {
            match document_to_review(&doc) {
                Ok(review) => HttpResponse::Ok().json(review),
                Err(e) => {
                    error!("Failed to deserialize review: {}", e);
                    HttpResponse::InternalServerError().json(serde_json::json!({
                        "error": "Failed to deserialize review"
                    }))
                }
            }
        }
        Ok(None) => {
            HttpResponse::NotFound().json(serde_json::json!({
                "error": "Review not found"
            }))
        }
        Err(e) => {
            error!("Failed to fetch review: {}", e);
            HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to fetch review"
            }))
        }
    }
}

async fn update_review(
    state: web::Data<AppState>,
    path: web::Path<String>,
    body: web::Json<UpdateReviewRequest>,
) -> HttpResponse {
    let review_id = path.into_inner();

    if body.rating < 1 || body.rating > 5 {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "error": "Rating must be between 1 and 5"
        }));
    }

    let existing = match state.collection.find_one(doc! { "id": &review_id }, None).await {
        Ok(Some(doc)) => doc,
        Ok(None) => {
            return HttpResponse::NotFound().json(serde_json::json!({
                "error": "Review not found"
            }));
        }
        Err(e) => {
            error!("Failed to fetch review: {}", e);
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to fetch review"
            }));
        }
    };

    let owner_id = match existing.get_str("userId") {
        Ok(uid) => uid.to_string(),
        Err(_) => {
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to read review owner"
            }));
        }
    };

    if owner_id != body.user_id {
        return HttpResponse::Forbidden().json(serde_json::json!({
            "error": "Not authorized to update this review"
        }));
    }

    let now = Utc::now().to_rfc3339();
    let update = doc! {
        "$set": {
            "rating": body.rating as i32,
            "comment": &body.comment,
            "updatedAt": &now,
        }
    };

    match state.collection.update_one(doc! { "id": &review_id }, update, None).await {
        Ok(_) => {
            match state.collection.find_one(doc! { "id": &review_id }, None).await {
                Ok(Some(doc)) => match document_to_review(&doc) {
                    Ok(review) => {
                        info!("Updated review {}", review_id);
                        HttpResponse::Ok().json(review)
                    }
                    Err(e) => {
                        error!("Failed to deserialize updated review: {}", e);
                        HttpResponse::InternalServerError().json(serde_json::json!({
                            "error": "Failed to deserialize review"
                        }))
                    }
                },
                _ => HttpResponse::InternalServerError().json(serde_json::json!({
                    "error": "Failed to fetch updated review"
                })),
            }
        }
        Err(e) => {
            error!("Failed to update review: {}", e);
            HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to update review"
            }))
        }
    }
}

async fn delete_review(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let review_id = path.into_inner();

    match state.collection.delete_one(doc! { "id": &review_id }, None).await {
        Ok(result) => {
            if result.deleted_count == 0 {
                HttpResponse::NotFound().json(serde_json::json!({
                    "error": "Review not found"
                }))
            } else {
                info!("Deleted review {}", review_id);
                HttpResponse::NoContent().finish()
            }
        }
        Err(e) => {
            error!("Failed to delete review: {}", e);
            HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to delete review"
            }))
        }
    }
}

async fn get_product_reviews(
    state: web::Data<AppState>,
    path: web::Path<String>,
    query: web::Query<PaginationQuery>,
) -> HttpResponse {
    let product_id = path.into_inner();
    let filter = doc! { "productId": &product_id };

    let page = query.page.unwrap_or(1).max(1);
    let limit = query.limit.unwrap_or(20).max(1);
    let skip = (page - 1) * limit;

    let total = match state.collection.count_documents(filter.clone(), None).await {
        Ok(count) => count,
        Err(e) => {
            error!("Failed to count product reviews: {}", e);
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to query reviews"
            }));
        }
    };

    let find_options = FindOptions::builder()
        .skip(skip)
        .limit(limit as i64)
        .build();

    let cursor = match state.collection.find(filter, find_options).await {
        Ok(cursor) => cursor,
        Err(e) => {
            error!("Failed to query product reviews: {}", e);
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to query reviews"
            }));
        }
    };

    let reviews = collect_reviews(cursor).await;

    HttpResponse::Ok().json(PaginatedResponse {
        reviews,
        total,
        page,
        limit,
    })
}

async fn get_product_stats(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let product_id = path.into_inner();

    let pipeline = vec![
        doc! { "$match": { "productId": &product_id } },
        doc! {
            "$group": {
                "_id": "$rating",
                "count": { "$sum": 1 }
            }
        },
    ];

    let mut cursor = match state.collection.aggregate(pipeline, None).await {
        Ok(cursor) => cursor,
        Err(e) => {
            error!("Failed to aggregate product stats: {}", e);
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to get product stats"
            }));
        }
    };

    let mut distribution: HashMap<String, u64> = HashMap::new();
    for i in 1..=5 {
        distribution.insert(i.to_string(), 0);
    }

    let mut total_reviews: u64 = 0;
    let mut rating_sum: u64 = 0;

    while let Some(result) = cursor.next().await {
        match result {
            Ok(doc) => {
                let rating = doc.get_i32("_id").unwrap_or(0) as u64;
                let count = doc.get_i32("count").unwrap_or(0) as u64;
                distribution.insert(rating.to_string(), count);
                total_reviews += count;
                rating_sum += rating * count;
            }
            Err(e) => {
                error!("Aggregation cursor error: {}", e);
            }
        }
    }

    let average_rating = if total_reviews > 0 {
        (rating_sum as f64 / total_reviews as f64 * 10.0).round() / 10.0
    } else {
        0.0
    };

    HttpResponse::Ok().json(RatingStats {
        product_id,
        average_rating,
        total_reviews,
        distribution,
    })
}

async fn get_user_reviews(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> HttpResponse {
    let user_id = path.into_inner();
    let filter = doc! { "userId": &user_id };

    let cursor = match state.collection.find(filter, None).await {
        Ok(cursor) => cursor,
        Err(e) => {
            error!("Failed to query user reviews: {}", e);
            return HttpResponse::InternalServerError().json(serde_json::json!({
                "error": "Failed to query reviews"
            }));
        }
    };

    let reviews = collect_reviews(cursor).await;

    HttpResponse::Ok().json(reviews)
}

async fn collect_reviews(mut cursor: mongodb::Cursor<Document>) -> Vec<Review> {
    let mut reviews: Vec<Review> = Vec::new();

    while let Some(result) = cursor.next().await {
        match result {
            Ok(doc) => {
                match document_to_review(&doc) {
                    Ok(review) => reviews.push(review),
                    Err(e) => {
                        error!("Failed to deserialize review: {}", e);
                    }
                }
            }
            Err(e) => {
                error!("Cursor error: {}", e);
            }
        }
    }

    reviews
}

async fn health() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "healthy",
        "service": "review-service"
    }))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenv::dotenv().ok();
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mongodb_uri = env::var("MONGODB_URI")
        .unwrap_or_else(|_| "mongodb://mongodb:27017".to_string());

    let port: u16 = env::var("PORT")
        .unwrap_or_else(|_| "8082".to_string())
        .parse()
        .expect("PORT must be a valid u16");

    info!("Connecting to MongoDB at {}", mongodb_uri);

    let client_options = ClientOptions::parse(&mongodb_uri)
        .await
        .expect("Failed to parse MongoDB URI");

    let client = Client::with_options(client_options)
        .expect("Failed to create MongoDB client");

    let db = client.database("reviews");
    let collection = db.collection::<Document>("reviews");

    info!("Connected to MongoDB database 'reviews'");

    let state = AppState { collection };

    let prometheus = PrometheusMetricsBuilder::new("review_service")
        .endpoint("/metrics")
        .build()
        .expect("Failed to create Prometheus metrics");

    info!("Starting review-service on port {}", port);

    HttpServer::new(move || {
        App::new()
            .wrap(prometheus.clone())
            .wrap(middleware::Logger::default())
            .app_data(web::Data::new(state.clone()))
            .route("/health", web::get().to(health))
            .route("/api/reviews", web::post().to(create_review))
            .route("/api/reviews", web::get().to(list_reviews))
            .route("/api/reviews/product/{productId}/stats", web::get().to(get_product_stats))
            .route("/api/reviews/product/{productId}", web::get().to(get_product_reviews))
            .route("/api/reviews/user/{userId}", web::get().to(get_user_reviews))
            .route("/api/reviews/{id}", web::get().to(get_review))
            .route("/api/reviews/{id}", web::put().to(update_review))
            .route("/api/reviews/{id}", web::delete().to(delete_review))
    })
    .bind(("0.0.0.0", port))?
    .shutdown_timeout(30)
    .run()
    .await
}
