# 04. 서비스 내부 구조와 통신 흐름

---

## 이 단계에서 학습하는 기술

| 기술 | 개념 |
|------|------|
| **서비스 디스커버리** | K8s Service 리소스가 DNS 레코드(ClusterIP)를 생성하여 Pod 간 통신을 추상화하는 메커니즘 |
| **AMQP** | Advanced Message Queuing Protocol. RabbitMQ가 구현하는 메시지 큐 프로토콜. Producer → Exchange → Queue → Consumer |
| **ORM/ODM** | Object-Relational/Document Mapping. 프로그래밍 언어의 객체를 DB 레코드에 매핑 (JPA, Mongoose, SQLAlchemy) |
| **Redis 데이터 구조** | Hash(장바구니), String(캐시), List(알림 이력) 등 용도별 데이터 구조 선택 |

---

## 1. 서비스 간 통신 구조

### 1.1 네트워크 흐름

```
[클라이언트] → NodePort:30080
       ↓
[Nginx Ingress Controller]
       ↓ 경로 기반 라우팅
[ClusterIP Service] → [Pod]
```

K8s Service의 ClusterIP는 가상 IP이다. kube-proxy(또는 Cilium)가 iptables/eBPF 규칙을 생성하여, ClusterIP로의 트래픽을 실제 Pod IP로 분배한다.

### 1.2 DNS 해석

ecommerce 네임스페이스 내에서 Service 이름으로 직접 접근 가능:
```
postgresql:5432        →  10.96.x.x:5432  (ClusterIP)
mongodb:27017          →  10.96.x.x:27017
redis:6379             →  10.96.x.x:6379
rabbitmq:5672          →  10.96.x.x:5672
order-service:8080     →  10.96.x.x:8080
```

FQDN 형식: `<service-name>.<namespace>.svc.cluster.local`
예: `postgresql.ecommerce.svc.cluster.local:5432`

**기술 해설 - CoreDNS**:
K8s 클러스터의 DNS 서버(CoreDNS)가 Service 리소스를 감시하고, 생성/삭제 시 DNS 레코드를 자동 갱신한다. Pod 내부의 `/etc/resolv.conf`는 CoreDNS를 nameserver로 설정한다.

---

## 2. 서비스별 내부 구조

### 2.1 order-service (Java/Spring Boot)

```
order-service (포트 8080)
│
├── OrderController.java
│   ├── POST /api/orders         → 주문 생성
│   ├── GET  /api/orders         → 주문 목록 (페이지네이션)
│   ├── GET  /api/orders/{id}    → 주문 상세
│   ├── PUT  /api/orders/{id}/status → 상태 변경
│   └── GET  /api/orders/health  → 헬스체크
│
├── OrderService.java
│   ├── createOrder()            → JPA save + RabbitMQ publish
│   ├── updateOrderStatus()      → 상태 머신 (PENDING→CONFIRMED→SHIPPED→DELIVERED)
│   └── cancelOrder()            → 상태를 CANCELLED로 변경 + order.cancelled 이벤트
│
├── Order.java (JPA Entity)
│   ├── @Entity, @Table(name="orders")
│   ├── id: UUID (자동 생성)
│   ├── status: OrderStatus (enum)
│   └── orderItems: List<OrderItem> (@OneToMany)
│
└── RabbitMQConfig.java
    ├── Exchange: order.exchange (TopicExchange)
    ├── Queue: order.created, order.shipped, order.cancelled
    └── Binding: routingKey로 Exchange-Queue 바인딩
```

**기술 해설 - JPA (Java Persistence API)**:
JPA는 Java 객체와 관계형 DB 테이블 간의 매핑 표준이다. `@Entity` 어노테이션이 붙은 클래스가 테이블에 매핑된다. Spring Data JPA의 `JpaRepository`는 CRUD 메서드를 자동 생성한다.

`EntityManager`가 영속성 컨텍스트(Persistence Context)를 관리한다. `save()` 호출 시 INSERT SQL이 즉시 실행되지 않고, 트랜잭션 커밋 시점에 flush된다. 이를 write-behind 방식이라 한다.

**기술 해설 - RabbitMQ Topic Exchange**:
Topic Exchange는 routing key의 패턴 매칭으로 메시지를 큐에 라우팅한다.
- `order.created` → `order.created` 큐에 전달
- `order.shipped` → `order.shipped` 큐에 전달
- `order.*` 패턴으로 바인딩하면 모든 order 이벤트를 수신 가능

Direct Exchange와 달리 와일드카드(`*`, `#`)를 지원하므로, 이벤트 유형별 세분화된 라우팅이 가능하다.

### 2.2 product-service (Node.js/Express)

```
product-service (포트 3000)
│
├── index.js (Express 앱)
│   ├── MongoDB 연결 (Mongoose)
│   ├── Redis 연결 (ioredis)
│   └── 10개 샘플 상품 자동 시딩
│
├── routes/products.js
│   ├── GET  /api/products          → 목록 (카테고리, 텍스트 검색, 정렬)
│   ├── GET  /api/products/:id      → 상세
│   ├── POST /api/products          → 생성
│   ├── PUT  /api/products/:id/stock → 재고 조정
│   └── GET  /api/products/categories/list → 카테고리 집계
│
├── models/Product.js (Mongoose Schema)
│   ├── name, description, price, stock
│   ├── category, tags
│   └── text index: name + description (전문 검색용)
│
└── middleware/cache.js
    ├── Redis GET → HIT → 캐시 데이터 반환
    └── Redis MISS → next() → 응답 가로채서 Redis SET (TTL 60초)
```

**기술 해설 - Redis 캐시 미들웨어 동작**:
```
요청 → cache.js middleware → Redis GET(key)
                ↓ HIT                    ↓ MISS
        JSON.parse → 응답          next() → route handler
                                         → MongoDB 조회
                                         → res.json() 가로채기
                                         → Redis SET(key, data, EX 60)
                                         → 응답
```
Express 미들웨어는 `req, res, next` 시그니처를 가진다. `next()`를 호출하면 다음 미들웨어/라우트 핸들러로 제어를 넘긴다. 캐시 미들웨어가 `res.json()`을 monkey-patch하여 응답 데이터를 가로채고 Redis에 저장한다.

### 2.3 cart-service (Go)

```
cart-service (포트 8081)
│
└── main.go
    ├── POST   /api/cart              → 아이템 추가 (Redis HSET)
    ├── GET    /api/cart/{userId}     → 장바구니 조회 (Redis HGETALL)
    ├── PUT    /api/cart/{userId}/{productId} → 수량 변경 (Redis HSET)
    ├── DELETE /api/cart/{userId}/{productId} → 아이템 삭제 (Redis HDEL)
    ├── DELETE /api/cart/{userId}     → 장바구니 비우기 (Redis DEL)
    ├── POST   /api/cart/checkout     → 주문 전환 (→ order-service HTTP 호출)
    └── GET    /metrics               → Prometheus 메트릭
```

**기술 해설 - Redis Hash 데이터 구조**:
장바구니는 Redis Hash로 저장한다:
```
Key: cart:{userId}
Field: {productId}  Value: {quantity, price 등 JSON}

HSET cart:user-1 prod-1 '{"quantity":2,"price":29.99}'
HSET cart:user-1 prod-2 '{"quantity":1,"price":49.99}'
HGETALL cart:user-1  → 전체 장바구니 조회
HDEL cart:user-1 prod-1  → 개별 아이템 삭제
```

Hash 구조의 장점:
- O(1) 복잡도로 개별 아이템 CRUD
- HGETALL로 전체 장바구니를 한 번의 명령으로 조회
- EXPIRE로 키 전체에 TTL 설정 (24시간 후 자동 만료)

**기술 해설 - checkout 서비스 간 HTTP 호출**:
```go
resp, err := http.Post("http://order-service:8080/api/orders",
    "application/json", bytes.NewBuffer(orderJSON))
```
cart-service가 order-service를 K8s Service 이름으로 호출한다. CoreDNS가 `order-service`를 ClusterIP로 해석하고, kube-proxy가 실제 Pod IP로 로드밸런싱한다.

### 2.4 user-service (Python/FastAPI)

```
user-service (포트 8000)
│
├── main.py
│   ├── POST /api/users/register    → 회원가입 (bcrypt 해시)
│   ├── POST /api/users/login       → 로그인 (JWT 발급)
│   ├── POST /api/users/logout      → 로그아웃 (세션 삭제)
│   ├── GET  /api/users/profile     → 프로필 조회 (JWT 검증)
│   ├── PUT  /api/users/profile     → 프로필 수정
│   └── PUT  /api/users/password    → 비밀번호 변경
│
├── models.py (SQLAlchemy async)
│   └── User: id, username, email, password_hash, role, created_at, updated_at
│
└── database.py
    └── AsyncSession + create_async_engine (asyncpg 드라이버)
```

**기술 해설 - ASGI (Asynchronous Server Gateway Interface)**:
FastAPI는 ASGI 프레임워크이다. WSGI(동기)와 달리 async/await 기반 비동기 I/O를 지원한다. Uvicorn이 ASGI 서버 역할을 하며, 이벤트 루프(asyncio)에서 요청을 처리한다.

asyncpg는 PostgreSQL의 바이너리 프로토콜을 직접 구현한 비동기 드라이버이다. psycopg2(동기) 대비 2~5배 높은 처리량을 제공한다. 커넥션 풀은 asyncpg의 `create_pool()`로 관리한다.

### 2.5 review-service (Rust/Actix-web)

```
review-service (포트 8082)
│
└── src/main.rs
    ├── POST /api/reviews             → 리뷰 작성 (중복 방지)
    ├── GET  /api/reviews             → 리뷰 목록 (페이지네이션)
    ├── GET  /api/reviews/product/{id} → 상품별 리뷰
    ├── GET  /api/reviews/product/{id}/stats → 별점 통계 (aggregation)
    ├── PUT  /api/reviews/{id}        → 리뷰 수정 (소유자 검증)
    └── GET  /api/reviews/user/{userId} → 유저별 리뷰
```

**기술 해설 - MongoDB Aggregation Pipeline**:
별점 통계는 MongoDB의 aggregation pipeline으로 계산한다:
```javascript
db.reviews.aggregate([
  { $match: { productId: "prod-1" } },           // 필터링
  { $group: {
      _id: "$productId",
      averageRating: { $avg: "$rating" },          // 평균 계산
      count: { $sum: 1 },                          // 개수
      distribution: { $push: "$rating" }           // 분포
  }}
])
```
aggregation pipeline은 UNIX 파이프라인과 유사한 구조이다. 각 stage(`$match`, `$group`, `$sort`)가 이전 stage의 출력을 입력으로 받아 처리한다. 클라이언트 측에서 전체 데이터를 가져와 집계하는 것보다 네트워크 전송량이 적고, DB 엔진의 인덱스를 활용할 수 있다.

### 2.6 notification-worker (Node.js RabbitMQ Consumer)

```
notification-worker (메트릭 포트 3001)
│
└── src/worker.js
    ├── Queue: order.created   → 이메일 + Push 알림 시뮬레이션
    ├── Queue: order.shipped   → SMS + Push 알림 시뮬레이션
    ├── Queue: order.cancelled → 이메일 알림 시뮬레이션
    ├── Redis LPUSH: 알림 이력 저장 (최근 100건, LTRIM)
    └── GET /api/notifications/{userId} → 알림 이력 조회
```

**기술 해설 - Message Acknowledgment**:
```javascript
channel.consume(queue, (msg) => {
  // 메시지 처리
  channel.ack(msg);  // 처리 완료 후 ACK
});
```
Consumer가 `ack()`를 호출해야 RabbitMQ가 큐에서 메시지를 제거한다. `ack()` 전에 Consumer가 죽으면 메시지는 다시 큐에 들어간다(requeue). 이 메커니즘이 at-least-once delivery를 보장한다.

`prefetch(1)` 설정은 Consumer에게 동시에 1개 메시지만 전달한다. 처리 완료(ack) 후 다음 메시지를 받으므로, 느린 Consumer가 과도한 메시지를 받는 것을 방지한다.

---

## 3. 데이터 흐름 검증

### 3.1 주문 생성 → 알림 수신 흐름 확인

```bash
DEV_IP=$(tart ip dev-master)
KUBECONFIG=../tart-infra/kubeconfig/dev.yaml

# 1. 주문 생성
curl -X POST http://${DEV_IP}:30080/api/orders \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","productId":"prod-1","quantity":1,"totalPrice":29.99}'
# → HTTP 201, orderId 반환

# 2. RabbitMQ 큐 확인 (Management API)
curl -s -u guest:guest http://${DEV_IP}:31672/api/queues/ecommerce/ | \
  python3 -m json.tool
# → order.created 큐의 messages 수가 일시적으로 증가 후 0으로 돌아옴
#   (notification-worker가 소비했음을 의미)

# 3. notification-worker 로그 확인
kubectl logs -n ecommerce -l app=notification-worker --tail=10
# → "[order.created] 알림 처리: orderId=xxx" 로그 출력

# 4. 주문 상태 확인
curl -s http://${DEV_IP}:30080/api/orders | python3 -m json.tool
```

---

## 4. 이 단계에서 확인할 것

- [ ] 주문 생성 후 notification-worker 로그에 소비 기록이 남는가
- [ ] 상품 조회 시 두 번째 요청이 첫 번째보다 빠른가 (캐시 효과)
- [ ] 장바구니 checkout 후 order-service에 주문이 생성되는가
- [ ] 유저 등록 → 로그인 → JWT 토큰 반환 → 프로필 조회가 동작하는가

다음 문서: [05-autoscaling.md](05-autoscaling.md)
