# Stage 1: Build
FROM --platform=linux/arm64 maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline -B
COPY src ./src
RUN mvn package -DskipTests -B

# Stage 2: Scouter Agent 다운로드
FROM --platform=linux/arm64 eclipse-temurin:17-jre-alpine AS scouter
RUN apk add --no-cache curl tar
ARG SCOUTER_VERSION=2.20.0
RUN curl -fsSL "https://github.com/scouter-project/scouter/releases/download/v${SCOUTER_VERSION}/scouter-all-${SCOUTER_VERSION}.tar.gz" \
    -o /tmp/scouter.tar.gz && \
    tar xzf /tmp/scouter.tar.gz -C /opt/ && \
    rm /tmp/scouter.tar.gz

# Stage 3: Runtime
FROM --platform=linux/arm64 eclipse-temurin:17-jre-alpine
WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=build /app/target/*.jar app.jar
COPY --from=scouter /opt/scouter/agent.java /app/scouter-agent

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 8080

# Scouter agent는 SCOUTER_ENABLED=true일 때만 활성화
# K8s 매니페스트에서 JAVA_OPTS 환경변수로 제어
ENTRYPOINT ["sh", "-c", "java ${JAVA_OPTS:-} -jar app.jar"]
