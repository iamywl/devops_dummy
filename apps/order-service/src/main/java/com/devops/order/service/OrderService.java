package com.devops.order.service;

import com.devops.order.config.RabbitMQConfig;
import com.devops.order.dto.CreateOrderRequest;
import com.devops.order.model.Order;
import com.devops.order.model.OrderItem;
import com.devops.order.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
@Slf4j
public class OrderService {

    private final OrderRepository orderRepository;
    private final RabbitTemplate rabbitTemplate;

    @Transactional
    public Order createOrder(CreateOrderRequest request) {
        Order order = Order.builder()
                .userId(request.getUserId())
                .email(request.getEmail())
                .shippingAddress(request.getShippingAddress())
                .productId(request.getItems() != null && !request.getItems().isEmpty()
                        ? request.getItems().get(0).getProductId() : "N/A")
                .quantity(request.getItems() != null
                        ? request.getItems().stream().mapToInt(CreateOrderRequest.ItemRequest::getQuantity).sum() : 0)
                .totalPrice(request.getTotalPrice())
                .status(Order.OrderStatus.PENDING)
                .build();

        if (request.getItems() != null) {
            for (CreateOrderRequest.ItemRequest itemReq : request.getItems()) {
                OrderItem item = OrderItem.builder()
                        .productId(itemReq.getProductId())
                        .productName(itemReq.getProductName())
                        .quantity(itemReq.getQuantity())
                        .unitPrice(itemReq.getUnitPrice())
                        .build();
                order.addItem(item);
            }
        }

        Order savedOrder = orderRepository.save(order);
        publishOrderEvent(savedOrder, RabbitMQConfig.ROUTING_KEY_CREATED);
        return savedOrder;
    }

    @Transactional
    public Optional<Order> cancelOrder(UUID id) {
        return orderRepository.findById(id).map(order -> {
            if (order.getStatus() != Order.OrderStatus.PENDING) {
                throw new IllegalStateException(
                        "Cannot cancel order in " + order.getStatus() + " status. Only PENDING orders can be cancelled.");
            }
            order.setStatus(Order.OrderStatus.CANCELLED);
            Order saved = orderRepository.save(order);
            publishOrderEvent(saved, RabbitMQConfig.ROUTING_KEY_CANCELLED);
            return saved;
        });
    }

    @Transactional
    public Optional<Order> updateOrderStatus(UUID id, Order.OrderStatus status) {
        return orderRepository.findById(id).map(order -> {
            order.setStatus(status);
            Order saved = orderRepository.save(order);

            String routingKey = resolveRoutingKey(status);
            if (routingKey != null) {
                publishOrderEvent(saved, routingKey);
            }

            return saved;
        });
    }

    @Transactional(readOnly = true)
    public Optional<Order> getOrderById(UUID id) {
        return orderRepository.findById(id);
    }

    @Transactional(readOnly = true)
    public List<Order> getOrdersByUserId(String userId) {
        return orderRepository.findByUserId(userId);
    }

    @Transactional(readOnly = true)
    public Page<Order> getAllOrders(Pageable pageable) {
        return orderRepository.findAll(pageable);
    }

    @Transactional(readOnly = true)
    public Page<Order> getOrdersByUserId(String userId, Pageable pageable) {
        return orderRepository.findByUserId(userId, pageable);
    }

    @Transactional
    public void deleteOrder(UUID id) {
        orderRepository.deleteById(id);
    }

    private void publishOrderEvent(Order order, String routingKey) {
        try {
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("orderId", order.getId().toString());
            event.put("userId", order.getUserId());
            event.put("email", order.getEmail());
            event.put("totalPrice", order.getTotalPrice());
            event.put("status", order.getStatus().name());

            if (order.getItems() != null && !order.getItems().isEmpty()) {
                List<Map<String, Object>> itemsList = order.getItems().stream()
                        .map(item -> {
                            Map<String, Object> m = new LinkedHashMap<>();
                            m.put("productId", item.getProductId());
                            m.put("productName", item.getProductName());
                            m.put("quantity", item.getQuantity());
                            m.put("unitPrice", item.getUnitPrice());
                            return m;
                        })
                        .collect(Collectors.toList());
                event.put("items", itemsList);
            }

            rabbitTemplate.convertAndSend(RabbitMQConfig.EXCHANGE_NAME, routingKey, event);
            log.info("Published {} event for order id={}", routingKey, order.getId());
        } catch (Exception e) {
            log.error("Failed to publish {} event for order id={}: {}", routingKey, order.getId(), e.getMessage());
        }
    }

    private String resolveRoutingKey(Order.OrderStatus status) {
        return switch (status) {
            case SHIPPED -> RabbitMQConfig.ROUTING_KEY_SHIPPED;
            case CANCELLED -> RabbitMQConfig.ROUTING_KEY_CANCELLED;
            default -> null;
        };
    }
}
