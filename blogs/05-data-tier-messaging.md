# 05. 데이터베이스 3종 + RabbitMQ 구성

## 핵심 요약

Polyglot Persistence 전략에 따라 PostgreSQL(ACID 트랜잭션), MongoDB(스키마리스 문서), Redis(인메모리 캐시/세션)를 서비스 특성에 맞게 배치하고, RabbitMQ Topic Exchange로 비동기 이벤트 기반 통신을 구현한다.

---

## 1. 왜 DB를 분리하는가

**모놀리식 DB의 문제점**:

```
모든 서비스 → 하나의 PostgreSQL
                   │
                   ├── 주문 테이블 (트랜잭션 필수)
                   ├── 상품 테이블 (스키마 유동적)
                   ├── 장바구니 테이블 (임시 데이터, 24시간 만료)
                   └── 리뷰 테이블 (비정형)

문제:
├── 상품 스키마 변경 시 전체 서비스 영향
├── 장바구니 조회가 트랜잭션 락을 잡으면 주문에 영향
├── 모든 읽기가 DB를 직접 히트 → 스케일링 병목
└── 서비스 독립 배포 불가 (DB 스키마 결합)
```

**Polyglot Persistence 해결책**:

```
order-service   → PostgreSQL (트랜잭션 정합성)
user-service    → PostgreSQL (인증 정보 무결성)
product-service → MongoDB (스키마 유연, 카탈로그)
review-service  → MongoDB (비정형 텍스트+평점)
cart-service    → Redis (24시간 TTL 임시 데이터)
product-service → Redis (60초 TTL 읽기 캐시)
user-service    → Redis (JWT 세션 저장소)
```

---

## 2. PostgreSQL 16 (StatefulSet)

### 2.1 K8s 매니페스트

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgresql
  namespace: ecommerce
spec:
  serviceName: postgresql
  replicas: 1
  selector:
    matchLabels:
      app: postgresql
  template:
    spec:
      containers:
        - name: postgresql
          image: postgres:16-alpine
          ports:
            - containerPort: 5432
          env:
            - name: POSTGRES_DB
              value: "orderdb"
            - name: POSTGRES_USER
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: postgres-user
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: postgres-password
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          volumeMounts:
            - name: postgresql-data
              mountPath: /var/lib/postgresql/data
          livenessProbe:
            exec:
              command: ["pg_isready", "-U", "postgres"]
            periodSeconds: 10
  volumeClaimTemplates:
    - metadata:
        name: postgresql-data
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests: { storage: 5Gi }
```

**왜 StatefulSet인가**: DB는 고정된 네트워크 ID(DNS)와 영속 스토리지(PVC)가 필요하다. Deployment는 Pod 재시작 시 이름이 바뀌고 PVC가 자동 재연결되지 않는다. StatefulSet은 `postgresql-0`이라는 고정 이름과 `postgresql-data-postgresql-0`이라는 고정 PVC를 보장한다.

### 2.2 Spring Boot 연결 설정

```properties
spring.datasource.url=jdbc:postgresql://${DB_HOST:postgresql}:${DB_PORT:5432}/${DB_NAME:orderdb}
spring.datasource.driver-class-name=org.postgresql.Driver
spring.jpa.hibernate.ddl-auto=update
spring.jpa.properties.hibernate.dialect=org.hibernate.dialect.PostgreSQLDialect
```

---

## 3. MongoDB 7 (StatefulSet)

### 3.1 K8s 매니페스트

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongodb
spec:
  serviceName: mongodb
  replicas: 1
  template:
    spec:
      containers:
        - name: mongodb
          image: mongo:7
          ports:
            - containerPort: 27017
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          volumeMounts:
            - name: mongodb-data
              mountPath: /data/db
```

### 3.2 product-service 연결

```javascript
// Mongoose ODM 연결
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGO_URI || 'mongodb://mongodb:27017/products', {
  // 커넥션 풀 설정
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
});

// 상품 스키마 (비정형 속성을 Mixed 타입으로 허용)
const productSchema = new mongoose.Schema({
  name: String,
  price: Number,
  category: String,
  stock: Number,
  attributes: mongoose.Schema.Types.Mixed,  // 카테고리별 다른 속성
  ratings: { average: Number, count: Number },
});
```

---

## 4. Redis 7 (Deployment)

### 4.1 왜 Deployment인가

Redis는 캐시/세션 용도이므로 데이터 영속성이 덜 중요하다. Pod가 재시작되면 캐시가 사라지지만, 원본 데이터는 PostgreSQL/MongoDB에 있으므로 문제없다.

### 4.2 3가지 용도

```
Redis 용도:
├── 1. 상품 캐시 (product-service)
│   Key: cache:/api/products
│   TTL: 60초
│   패턴: Read-Through (캐시 미스 → DB 조회 → 캐시 저장)
│
├── 2. 장바구니 저장 (cart-service)
│   Key: cart:{userId}
│   Type: Hash (field=productId, value=JSON)
│   TTL: 24시간
│
└── 3. JWT 세션 (user-service)
    Key: session:{sessionId}
    Value: userId
    TTL: 60분 (JWT 만료와 동일)
    목적: 로그아웃 시 즉시 세션 무효화
```

### 4.3 K8s 매니페스트

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: redis
          image: redis:7-alpine
          ports:
            - containerPort: 6379
          command: ["redis-server", "--maxmemory", "200mb", "--maxmemory-policy", "allkeys-lru"]
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits:   { cpu: 200m, memory: 256Mi }
```

`--maxmemory-policy allkeys-lru`: 메모리 한도 도달 시 가장 오래 사용되지 않은 키부터 자동 제거.

---

## 5. RabbitMQ 3 (StatefulSet)

### 5.1 메시지 아키텍처

```
order-service
    │
    └── PUBLISH → order.exchange (Topic Exchange)
                    │
                    ├── routing key: order.created → order.created 큐
                    ├── routing key: order.shipped → order.shipped 큐
                    └── routing key: order.cancelled → order.cancelled 큐
                                                          │
                                                          ▼
                                                   notification-worker
                                                   (3개 큐 동시 소비)
```

**왜 Topic Exchange인가**: Direct Exchange는 라우팅 키가 정확히 일치해야 하지만, Topic Exchange는 와일드카드(`order.*`)를 사용할 수 있어 향후 `order.refunded` 등 새 이벤트를 추가하기 쉽다.

### 5.2 K8s 매니페스트

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: rabbitmq
spec:
  serviceName: rabbitmq
  replicas: 1
  template:
    spec:
      containers:
        - name: rabbitmq
          image: rabbitmq:3-management    # Management UI 포함
          ports:
            - containerPort: 5672         # AMQP
              name: amqp
            - containerPort: 15672        # Management UI
              name: management
          env:
            - name: RABBITMQ_DEFAULT_USER
              value: "guest"
            - name: RABBITMQ_DEFAULT_PASS
              value: "guest"
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { cpu: 300m, memory: 512Mi }
```

### 5.3 KEDA 연동

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: notification-worker-scaler
spec:
  scaleTargetRef:
    name: prod-notification-worker
  minReplicaCount: 1
  maxReplicaCount: 10
  triggers:
    - type: rabbitmq
      metadata:
        host: "amqp://guest:guest@prod-rabbitmq:5672"
        queueName: "order.created"
        mode: QueueLength
        value: "5"    # 큐에 5개 이상이면 스케일아웃
```

---

## 6. Secret 관리

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: ecommerce
type: Opaque
data:
  postgres-user: cG9zdGdyZXM=        # base64("postgres")
  postgres-password: cG9zdGdyZXMxMjM=  # base64("postgres123")
```

> **주의**: Secret은 base64 인코딩일 뿐 암호화가 아니다.
> 프로덕션에서는 Sealed Secrets, HashiCorp Vault, AWS Secrets Manager 등을 사용해야 한다.

---

## 다음 편

[06. HPA + KEDA로 탄력적 오토스케일링 구현하기](06-autoscaling.md)에서는 부하에 따라 자동으로 Pod를 늘리는 메커니즘을 구현한다.
