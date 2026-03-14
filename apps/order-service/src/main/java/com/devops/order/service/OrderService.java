package com.devops.order.service;

import com.devops.order.model.Order;
import com.devops.order.repository.OrderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
@RequiredArgsConstructor
@Slf4j
public class OrderService {

    private final OrderRepository orderRepository;
    private final RabbitTemplate rabbitTemplate;

    public static final String EXCHANGE_NAME = "order.exchange";
    public static final String ROUTING_KEY = "order.created";

    @Transactional
    public Order createOrder(Order order) {
        order.setStatus(Order.OrderStatus.PENDING);
        Order savedOrder = orderRepository.save(order);

        try {
            rabbitTemplate.convertAndSend(EXCHANGE_NAME, ROUTING_KEY, savedOrder.getId().toString());
            log.info("Published order.created event for order id={}", savedOrder.getId());
        } catch (Exception e) {
            log.error("Failed to publish order.created event for order id={}: {}",
                    savedOrder.getId(), e.getMessage());
        }

        return savedOrder;
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
    public List<Order> getAllOrders() {
        return orderRepository.findAll();
    }

    @Transactional
    public Optional<Order> updateOrderStatus(UUID id, Order.OrderStatus status) {
        return orderRepository.findById(id).map(order -> {
            order.setStatus(status);
            return orderRepository.save(order);
        });
    }

    @Transactional
    public void deleteOrder(UUID id) {
        orderRepository.deleteById(id);
    }
}
