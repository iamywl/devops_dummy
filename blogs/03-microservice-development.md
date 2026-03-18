# 03. 5개 언어로 마이크로서비스 개발하기

## 핵심 요약

Java/Node.js/Go/Python/Rust 5개 언어로 각각의 서비스 특성에 맞는 마이크로서비스를 구현한다. 모든 서비스는 헬스체크, Prometheus 메트릭 엔드포인트, Graceful Shutdown을 공통으로 갖는다.

---

## 1. 서비스별 공통 패턴

모든 마이크로서비스에 반드시 구현해야 하는 3가지:

```
1. /health 엔드포인트
   → K8s readinessProbe/livenessProbe가 호출
   → 의존 서비스(DB, Redis, MQ) 연결 상태 체크

2. /metrics 엔드포인트
   → Prometheus가 15초마다 스크래핑
   → http_requests_total, http_request_duration_seconds 필수

3. Graceful Shutdown
   → SIGTERM 수신 시 진행 중인 요청 처리 후 종료
   → K8s terminationGracePeriodSeconds(30s) 내 종료 완료
```

---

## 2. order-service (Java 17 / Spring Boot 3.2)

### 2.1 왜 Java/Spring Boot인가

주문 서비스는 **ACID 트랜잭션이 핵심**이다. 금액을 다루는 서비스에서 데이터 정합성이 깨지면 치명적이다. Spring Boot의 `@Transactional` + JPA가 이를 가장 안정적으로 보장한다.

또한 국내 기업 대부분이 Tomcat 기반 WAS를 운영하므로, 이 서비스를 통해 **Java WAS 운영 역량**을 증명한다.

### 2.2 프로젝트 구조

```
apps/order-service/
├── Dockerfile                    # 3-stage 멀티스테이지 빌드
├── pom.xml                       # Maven 의존성
└── src/main/
    ├── java/com/devops/order/
    │   ├── OrderApplication.java # Spring Boot 메인
    │   ├── controller/
    │   │   └── OrderController.java  # REST API
    │   ├── service/
    │   │   └── OrderService.java     # 비즈니스 로직 + MQ 발행
    │   ├── model/
    │   │   └── Order.java            # JPA Entity
    │   ├── repository/
    │   │   └── OrderRepository.java  # Spring Data JPA
    │   └── config/
    │       └── RabbitMQConfig.java    # Exchange, Queue, Binding
    └── resources/
        └── application.properties    # DB/MQ/Actuator 설정
```

### 2.3 핵심 코드 구현

**pom.xml** - 핵심 의존성:

```xml
<dependencies>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-web</artifactId>
        <!-- 내장 Tomcat 10 포함 -->
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-data-jpa</artifactId>
        <!-- Hibernate ORM + PostgreSQL 연동 -->
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-amqp</artifactId>
        <!-- RabbitMQ 클라이언트 -->
    </dependency>
    <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-starter-actuator</artifactId>
        <!-- /actuator/health, /actuator/prometheus -->
    </dependency>
    <dependency>
        <groupId>io.micrometer</groupId>
        <artifactId>micrometer-registry-prometheus</artifactId>
        <!-- Prometheus 메트릭 포맷 변환 -->
    </dependency>
</dependencies>
```

**Order.java** - JPA Entity:

```java
@Entity
@Table(name = "orders")
public class Order {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    private String userId;
    private String productId;
    private int quantity;
    private BigDecimal totalPrice;

    @Enumerated(EnumType.STRING)
    private OrderStatus status = OrderStatus.PENDING;

    @CreationTimestamp
    private LocalDateTime createdAt;

    // enum: PENDING, CONFIRMED, SHIPPED, DELIVERED, CANCELLED
}
```

**OrderService.java** - 비즈니스 로직:

```java
@Service
@Transactional
public class OrderService {
    private final OrderRepository repository;
    private final RabbitTemplate rabbitTemplate;

    public Order createOrder(Order order) {
        // 1. DB 저장 (JPA, 트랜잭션)
        Order saved = repository.save(order);

        // 2. RabbitMQ에 이벤트 발행 (비동기)
        try {
            rabbitTemplate.convertAndSend(
                "order.exchange",    // Topic Exchange
                "order.created",     // Routing Key
                saved                // 메시지 본문
            );
        } catch (Exception e) {
            log.error("Failed to publish order event", e);
            // 주문 자체는 성공, 알림 실패는 별도 처리
        }

        return saved;
    }
}
```

**RabbitMQConfig.java** - Exchange/Queue 설정:

```java
@Configuration
public class RabbitMQConfig {
    @Bean
    public TopicExchange orderExchange() {
        return new TopicExchange("order.exchange");
    }

    @Bean
    public Queue orderCreatedQueue() {
        return new Queue("order.created", true); // durable
    }

    @Bean
    public Binding binding() {
        return BindingBuilder
            .bind(orderCreatedQueue())
            .to(orderExchange())
            .with("order.created");
    }
}
```

**application.properties**:

```properties
# PostgreSQL
spring.datasource.url=jdbc:postgresql://${DB_HOST:postgresql}:${DB_PORT:5432}/${DB_NAME:orderdb}
spring.jpa.hibernate.ddl-auto=update

# RabbitMQ
spring.rabbitmq.host=rabbitmq
spring.rabbitmq.port=5672

# Actuator (Prometheus + Health)
management.endpoints.web.exposure.include=health,prometheus
management.endpoint.health.probes.enabled=true
```

### 2.4 Dockerfile (3-stage 빌드)

```dockerfile
# Stage 1: 빌드
FROM maven:3.9-eclipse-temurin-17 AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline  # 의존성 캐싱
COPY src ./src
RUN mvn package -DskipTests

# Stage 2: Scouter APM 에이전트 다운로드
FROM alpine:3.19 AS scouter
RUN wget -O /tmp/scouter.tar.gz \
  https://github.com/scouter-project/scouter/releases/download/v2.20.0/scouter-all-2.20.0.tar.gz
RUN tar xzf /tmp/scouter.tar.gz -C /opt

# Stage 3: 실행
FROM eclipse-temurin:17-jre-alpine
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /app/target/*.jar /app/app.jar
COPY --from=scouter /opt/scouter/agent.java /app/scouter-agent
USER app
ENTRYPOINT ["sh", "-c", "java ${JAVA_OPTS} -jar /app/app.jar"]
```

---

## 3. product-service (Node.js 20 / Express)

### 3.1 왜 Node.js인가

상품 조회는 전체 트래픽의 70%를 차지하는 **읽기 위주** 서비스다. Node.js의 이벤트 루프 기반 비동기 I/O가 대량의 동시 읽기 요청을 효율적으로 처리한다.

### 3.2 핵심 구현

**src/index.js**:

```javascript
const express = require('express');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const promClient = require('prom-client');

// Prometheus 메트릭
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });
const httpRequests = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'endpoint', 'status'],
  registers: [register],
});

// MongoDB 연결 + 시드 데이터
mongoose.connect(process.env.MONGO_URI || 'mongodb://mongodb:27017/products');

// Redis 연결 (캐시용)
const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  retryStrategy: (times) => Math.min(times * 200, 5000),
});

const app = express();
const PORT = process.env.PORT || 3001;  // product-service는 3001 포트

// /metrics 엔드포인트
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
```

**src/middleware/cache.js** - Redis 캐시 미들웨어:

```javascript
// Read-Through 캐시 패턴
const cacheMiddleware = (ttl = 60) => async (req, res, next) => {
  const key = `cache:${req.originalUrl}`;

  try {
    const cached = await redis.get(key);
    if (cached) {
      return res.json(JSON.parse(cached));  // 캐시 HIT → 바로 응답
    }
  } catch (err) {
    // Redis 장애 시 캐시 없이 계속 진행 (Graceful Degradation)
  }

  // 원래 res.json을 래핑하여 응답 시 캐시 저장
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    redis.setex(key, ttl, JSON.stringify(data)).catch(() => {});
    return originalJson(data);
  };

  next();
};
```

**상품 시드 데이터**:

```javascript
// MongoDB 연결 후 자동 시드 (10개 상품)
const seedProducts = [
  { name: "무선 블루투스 이어폰", price: 49900, category: "electronics", stock: 500 },
  { name: "스테인리스 텀블러", price: 15900, category: "kitchen", stock: 1000 },
  // ... 8개 더
];
```

---

## 4. cart-service (Go 1.22)

### 4.1 왜 Go인가

장바구니는 **Redis Hash 조작만** 수행하는 단순 CRUD다. Go의 정적 바이너리는 64Mi 메모리로 동작하며, 프레임워크 없이 표준 라이브러리(`net/http`)만으로 구현할 수 있다.

### 4.2 핵심 구현

```go
package main

// Redis Hash 기반 장바구니 저장 구조
// Key: cart:{userId}
// Field: {productId}
// Value: JSON {"productId":"...", "quantity":2, "addedAt":"..."}
// TTL: 24시간

func handleAddItem(w http.ResponseWriter, r *http.Request) {
    var req AddItemRequest
    json.NewDecoder(r.Body).Decode(&req)

    key := fmt.Sprintf("cart:%s", req.UserID)

    // 기존 아이템이 있으면 수량 합산
    existing, err := rdb.HGet(ctx, key, req.ProductID).Result()
    if err == redis.Nil {
        // 새 아이템 추가
        item := CartItem{ProductID: req.ProductID, Quantity: req.Quantity}
        rdb.HSet(ctx, key, req.ProductID, cartItemToJSON(item))
    } else {
        // 기존 수량에 추가
        item := parseCartItem(existing)
        item.Quantity += req.Quantity
        rdb.HSet(ctx, key, req.ProductID, cartItemToJSON(item))
    }

    rdb.Expire(ctx, key, 24 * time.Hour)
}

// 체크아웃: 장바구니 → 주문 생성 → 장바구니 삭제
func handleCheckout(w http.ResponseWriter, r *http.Request) {
    // 1. Redis에서 장바구니 조회
    cartItems := getCartItems(ctx, key)

    // 2. order-service에 HTTP POST
    resp := httpClient.Post(orderServiceURL, "application/json", body)

    // 3. 주문 성공 시 장바구니 삭제
    if resp.StatusCode < 300 {
        rdb.Del(ctx, key)
    }
}

// Graceful Shutdown
func main() {
    srv := &http.Server{Addr: ":8081", Handler: mux}
    go srv.ListenAndServe()

    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
    defer cancel()
    srv.Shutdown(ctx)
}
```

---

## 5. user-service (Python 3.12 / FastAPI)

### 5.1 왜 FastAPI인가

사용자 서비스는 **JWT 인증 + 세션 관리**가 핵심이다. FastAPI는 async/await를 네이티브로 지원하고, Pydantic으로 입력 검증, Swagger UI 자동 생성을 제공한다.

### 5.2 핵심 구현

```python
from fastapi import FastAPI, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from jose import jwt
import bcrypt

app = FastAPI()

# 사용자 등록
@app.post("/api/users")
async def register(user: UserCreate, db: AsyncSession = Depends(get_db)):
    hashed = bcrypt.hashpw(user.password.encode(), bcrypt.gensalt())
    db_user = User(username=user.username, email=user.email, password_hash=hashed)
    db.add(db_user)
    await db.commit()
    return {"id": str(db_user.id), "username": db_user.username}

# 로그인 → JWT 발급
@app.post("/api/users/login")
async def login(creds: LoginRequest, db: AsyncSession):
    user = await get_user_by_email(db, creds.email)
    if not user or not bcrypt.checkpw(creds.password.encode(), user.password_hash):
        raise HTTPException(401, "Invalid credentials")

    session_id = str(uuid4())
    token = jwt.encode(
        {"sub": str(user.id), "session_id": session_id, "exp": datetime.utcnow() + timedelta(hours=1)},
        SECRET_KEY, algorithm="HS256"
    )

    # Redis에 세션 저장 (토큰 무효화용)
    await redis.setex(f"session:{session_id}", 3600, str(user.id))

    return {"token": token}

# 로그아웃 → Redis 세션 삭제
@app.post("/api/users/logout")
async def logout(current_user: User = Depends(get_current_user)):
    await redis.delete(f"session:{current_user.session_id}")
    return {"message": "Logged out"}
```

---

## 6. review-service (Rust 1.77 / Actix-web)

### 6.1 왜 Rust인가

리뷰 서비스는 MongoDB Aggregation Pipeline으로 평점 통계를 계산하는데, Rust의 소유권 모델이 동시 요청에서 메모리 안전성을 보장한다. 30m CPU / 32Mi 메모리로 동작하는 **가장 경량** 서비스다.

### 6.2 핵심 구현

```rust
use actix_web::{web, App, HttpServer, HttpResponse};
use mongodb::{Client, Collection};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Review {
    product_id: String,
    user_id: String,
    rating: u8,       // 1-5
    comment: String,
    created_at: DateTime,
}

// 리뷰 생성 (중복 방지)
async fn create_review(
    db: web::Data<Collection<Review>>,
    body: web::Json<Review>,
) -> HttpResponse {
    // 같은 유저가 같은 상품에 이미 리뷰를 남겼는지 확인
    let existing = db.find_one(
        doc! { "product_id": &body.product_id, "user_id": &body.user_id },
        None
    ).await;

    if existing.is_some() {
        return HttpResponse::Conflict().json({"error": "duplicate review"});
    }

    db.insert_one(&body.into_inner(), None).await;
    HttpResponse::Created().finish()
}

// 상품별 평점 통계 (MongoDB Aggregation)
async fn get_product_stats(product_id: &str) -> RatingStats {
    let pipeline = vec![
        doc! { "$match": { "product_id": product_id } },
        doc! { "$group": {
            "_id": "$product_id",
            "avg_rating": { "$avg": "$rating" },
            "count": { "$sum": 1 },
            "distribution": { "$push": "$rating" }
        }},
    ];
    collection.aggregate(pipeline, None).await
}
```

---

## 7. notification-worker (Node.js / RabbitMQ Consumer)

### 7.1 구현 포인트

이 서비스는 HTTP 서버가 아니라 **MQ Consumer**다. RabbitMQ의 3개 큐를 소비하여 알림을 시뮬레이션한다.

```javascript
const amqp = require('amqplib');

async function startConsumer() {
  const conn = await amqp.connect('amqp://guest:guest@rabbitmq:5672');
  const channel = await conn.createChannel();

  // 3개 큐 동시 소비
  const queues = ['order.created', 'order.shipped', 'order.cancelled'];
  for (const queue of queues) {
    await channel.assertQueue(queue, { durable: true });
    channel.consume(queue, async (msg) => {
      const order = JSON.parse(msg.content.toString());

      // 알림 시뮬레이션 (실제 전송 대신 로깅 + 지연)
      await simulateEmail(order);  // 10-50ms
      await simulateSMS(order);    // 5-30ms
      await simulatePush(order);   // 5-20ms

      // Redis에 알림 이력 저장
      await redis.lpush(`notifications:${order.userId}`, JSON.stringify(notification));
      await redis.ltrim(`notifications:${order.userId}`, 0, 99); // 최근 100개만 유지

      channel.ack(msg);  // 처리 완료 확인
    });
  }
}
```

**KEDA와의 연동**: 이 서비스의 Pod 수는 HPA가 아니라 KEDA가 제어한다. 큐에 메시지가 5개 이상 쌓이면 Pod를 추가 생성하고, 큐가 비면 1개로 축소한다.

---

## 8. frontend (Nginx Static)

```nginx
# nginx.conf
server {
    listen 80;

    # 정적 파일
    location / {
        root /usr/share/nginx/html;
        try_files $uri $uri/ /index.html;
    }

    # API 리버스 프록시
    location /api/orders   { proxy_pass http://order-service:8080; }
    location /api/products { proxy_pass http://product-service:3000; }
    location /api/cart     { proxy_pass http://cart-service:8081; }
    location /api/users    { proxy_pass http://user-service:8000; }
    location /api/reviews  { proxy_pass http://review-service:8082; }
}
```

---

## 9. 직접 해보기

### 9.1 디렉토리 구조 생성

프로젝트 루트에서 모든 서비스 디렉토리를 생성한다:

```bash
cd ~/devops_dummpy  # 프로젝트 루트 경로로 이동

# 앱 디렉토리 생성
for svc in order-service product-service cart-service user-service review-service notification-worker frontend; do
  mkdir -p apps/$svc/src
done

# order-service Java 구조
mkdir -p apps/order-service/src/main/java/com/devops/order/{controller,service,model,repository,config}
mkdir -p apps/order-service/src/main/resources
```

### 9.2 소스 파일 작성

위 2~8절의 코드를 아래 경로에 각각 저장한다:

```
apps/order-service/
├── Dockerfile                                    # 2.4절
├── pom.xml                                       # 2.3절
└── src/main/
    ├── java/com/devops/order/
    │   ├── OrderApplication.java                 # Spring Boot @SpringBootApplication main
    │   ├── controller/OrderController.java       # REST @RestController
    │   ├── service/OrderService.java             # 2.3절 비즈니스 로직
    │   ├── model/Order.java                      # 2.3절 JPA Entity
    │   ├── repository/OrderRepository.java       # extends JpaRepository<Order, UUID>
    │   └── config/RabbitMQConfig.java            # 2.3절 Exchange/Queue
    └── resources/application.properties          # 2.3절

apps/product-service/
├── Dockerfile                                    # 4편 참조
├── package.json
└── src/
    ├── index.js                                  # 3절
    └── middleware/cache.js                        # 3절 Redis 캐시

apps/cart-service/
├── Dockerfile                                    # 4편 참조
├── go.mod
├── go.sum
└── main.go                                       # 4절

apps/user-service/
├── Dockerfile                                    # 4편 참조
├── requirements.txt
└── main.py                                       # 5절

apps/review-service/
├── Dockerfile                                    # 4편 참조
├── Cargo.toml
├── Cargo.lock
└── src/main.rs                                   # 6절

apps/notification-worker/
├── Dockerfile
├── package.json
└── src/index.js                                  # 7절

apps/frontend/
├── Dockerfile
├── nginx.conf                                    # 8절
└── public/index.html
```

> 각 서비스의 소스코드는 프로젝트의 `apps/` 디렉토리에 이미 완성되어 있다.
> 처음부터 직접 작성하려면 위 절의 코드를 해당 경로에 복사하면 된다.

### 9.3 각 서비스 로컬 테스트

서비스를 K8s에 배포하기 전에 로컬에서 먼저 테스트한다 (선택사항, DB/MQ가 로컬에 있어야 동작):

```bash
# product-service (Node.js)
cd apps/product-service
npm install
MONGO_URI=mongodb://localhost:27017/products \
REDIS_HOST=localhost \
node src/index.js
# → http://localhost:3001/api/products

# cart-service (Go)
cd apps/cart-service
go mod download
REDIS_HOST=localhost go run main.go
# → http://localhost:8081/api/cart

# order-service (Java)
cd apps/order-service
mvn spring-boot:run
# → http://localhost:8080/api/orders
```

### 9.4 K8s 배포 후 서비스 간 통신 테스트

04편에서 K8s에 배포한 후, 다음으로 확인한다:

```bash
DEV_IP=$(tart ip dev-master)

# 1. 상품 조회
curl http://${DEV_IP}:30080/api/products

# 2. 장바구니에 상품 추가
curl -X POST http://${DEV_IP}:30080/api/cart \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":2}'

# 3. 장바구니 조회
curl http://${DEV_IP}:30080/api/cart/user-1

# 4. 주문 생성
curl -X POST http://${DEV_IP}:30080/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":1,"totalPrice":29.99}'
```

---

## 다음 편

[04. Docker 멀티스테이지 빌드와 K8s 배포](04-container-build-deploy.md)에서는 이 서비스들을 Docker 이미지로 빌드하고 K8s에 배포한다.
