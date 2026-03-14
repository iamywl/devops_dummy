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

  // ---- GET /api/products ----
  router.get("/", cacheMiddleware(redis, 60), async (req, res) => {
    try {
      const { category, limit = 50, offset = 0 } = req.query;
      const filter = category ? { category } : {};

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
