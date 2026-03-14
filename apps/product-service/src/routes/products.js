const express = require("express");
const Product = require("../models/Product");
const { cacheMiddleware, invalidateCache } = require("../middleware/cache");

/**
 * Create the products router.
 *
 * @param {import("ioredis").Redis} redis – ioredis client
 * @returns {express.Router}
 */
function createProductsRouter(redis) {
  const router = express.Router();

  const CACHE_PREFIX = "cache:/api/products";

  // ---- GET /api/products/search ----
  router.get("/search", cacheMiddleware(redis, 60), async (req, res) => {
    try {
      const { q, limit = 50, offset = 0 } = req.query;

      if (!q || !q.trim()) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
      }

      const regex = new RegExp(q, "i");
      const filter = {
        $or: [{ name: regex }, { description: regex }],
      };

      const [products, total] = await Promise.all([
        Product.find(filter)
          .sort({ createdAt: -1 })
          .skip(Number(offset))
          .limit(Number(limit))
          .lean(),
        Product.countDocuments(filter),
      ]);

      res.json({ total, limit: Number(limit), offset: Number(offset), products });
    } catch (err) {
      console.error("GET /api/products/search error:", err);
      res.status(500).json({ error: "Failed to search products" });
    }
  });

  // ---- GET /api/products/categories ----
  router.get("/categories", cacheMiddleware(redis, 120), async (_req, res) => {
    try {
      const categories = await Product.aggregate([
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $project: { _id: 0, category: "$_id", count: 1 } },
      ]);

      res.json(categories);
    } catch (err) {
      console.error("GET /api/products/categories error:", err);
      res.status(500).json({ error: "Failed to fetch categories" });
    }
  });

  // ---- GET /api/products ----
  router.get("/", cacheMiddleware(redis, 60), async (req, res) => {
    try {
      const { category, limit = 50, offset = 0, sort, minPrice, maxPrice } = req.query;
      const filter = {};

      if (category) {
        filter.category = category;
      }

      if (minPrice !== undefined || maxPrice !== undefined) {
        filter.price = {};
        if (minPrice !== undefined) filter.price.$gte = Number(minPrice);
        if (maxPrice !== undefined) filter.price.$lte = Number(maxPrice);
      }

      let sortOption;
      switch (sort) {
        case "price_asc":
          sortOption = { price: 1 };
          break;
        case "price_desc":
          sortOption = { price: -1 };
          break;
        case "newest":
          sortOption = { createdAt: -1 };
          break;
        default:
          sortOption = { createdAt: -1 };
      }

      const [products, total] = await Promise.all([
        Product.find(filter)
          .sort(sortOption)
          .skip(Number(offset))
          .limit(Number(limit))
          .lean(),
        Product.countDocuments(filter),
      ]);

      res.json({ total, limit: Number(limit), offset: Number(offset), products });
    } catch (err) {
      console.error("GET /api/products error:", err);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  // ---- GET /api/products/:id ----
  router.get("/:id", cacheMiddleware(redis, 60), async (req, res) => {
    try {
      const product = await Product.findById(req.params.id).lean();
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json(product);
    } catch (err) {
      if (err.name === "CastError") {
        return res.status(400).json({ error: "Invalid product ID" });
      }
      console.error("GET /api/products/:id error:", err);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  });

  // ---- POST /api/products ----
  router.post("/", async (req, res) => {
    try {
      const { name, description, price, category, imageUrl, stock, reviews } = req.body;

      if (!name || price == null) {
        return res.status(400).json({ error: "name and price are required" });
      }

      const product = await Product.create({
        name,
        description,
        price,
        category,
        imageUrl,
        stock,
        reviews,
      });

      await invalidateCache(redis, CACHE_PREFIX);

      res.status(201).json(product);
    } catch (err) {
      if (err.name === "ValidationError") {
        return res.status(400).json({ error: err.message });
      }
      console.error("POST /api/products error:", err);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  // ---- PUT /api/products/:id ----
  router.put("/:id", async (req, res) => {
    try {
      const product = await Product.findByIdAndUpdate(
        req.params.id,
        { $set: req.body },
        { new: true, runValidators: true }
      );

      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      await invalidateCache(redis, CACHE_PREFIX);

      res.json(product);
    } catch (err) {
      if (err.name === "CastError") {
        return res.status(400).json({ error: "Invalid product ID" });
      }
      if (err.name === "ValidationError") {
        return res.status(400).json({ error: err.message });
      }
      console.error("PUT /api/products/:id error:", err);
      res.status(500).json({ error: "Failed to update product" });
    }
  });

  // ---- PATCH /api/products/:id/stock ----
  router.patch("/:id/stock", async (req, res) => {
    try {
      const { adjustment } = req.body;

      if (adjustment == null || typeof adjustment !== "number") {
        return res.status(400).json({ error: "adjustment (number) is required" });
      }

      const product = await Product.findById(req.params.id);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      const newStock = product.stock + adjustment;
      if (newStock < 0) {
        return res.status(400).json({
          error: "Insufficient stock",
          currentStock: product.stock,
          requestedAdjustment: adjustment,
        });
      }

      product.stock = newStock;
      await product.save();

      await invalidateCache(redis, CACHE_PREFIX);

      res.json({ id: product._id, stock: product.stock });
    } catch (err) {
      if (err.name === "CastError") {
        return res.status(400).json({ error: "Invalid product ID" });
      }
      console.error("PATCH /api/products/:id/stock error:", err);
      res.status(500).json({ error: "Failed to adjust stock" });
    }
  });

  // ---- DELETE /api/products/:id ----
  router.delete("/:id", async (req, res) => {
    try {
      const product = await Product.findByIdAndDelete(req.params.id);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      await invalidateCache(redis, CACHE_PREFIX);

      res.json({ message: "Product deleted", id: req.params.id });
    } catch (err) {
      if (err.name === "CastError") {
        return res.status(400).json({ error: "Invalid product ID" });
      }
      console.error("DELETE /api/products/:id error:", err);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });

  return router;
}

module.exports = createProductsRouter;
