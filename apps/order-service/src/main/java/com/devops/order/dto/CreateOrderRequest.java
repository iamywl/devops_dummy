package com.devops.order.dto;

import lombok.*;

import java.math.BigDecimal;
import java.util.List;

@Getter
@Setter
@NoArgsConstructor
@AllArgsConstructor
@Builder
public class CreateOrderRequest {

    private String userId;
    private String email;
    private String shippingAddress;
    private List<ItemRequest> items;
    private BigDecimal totalPrice;

    @Getter
    @Setter
    @NoArgsConstructor
    @AllArgsConstructor
    @Builder
    public static class ItemRequest {
        private String productId;
        private String productName;
        private int quantity;
        private BigDecimal unitPrice;
    }
}
