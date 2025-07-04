import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

console.log("🔑 Loaded Yelp Key (short):", process.env.YELP_API_KEY?.slice(0, 8));

const app = express();
const port = process.env.PORT || 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(express.json());

// ✅ Yelp API route
app.post("/api/yelp", async (req, res) => {
  const { location = "Los Angeles", price = "1,2,3", radius = 8000 } = req.body;
  console.log("📨 Received Yelp POST with body:", req.body);

  try {
    const yelpResponse = await axios.get("https://api.yelp.com/v3/businesses/search", {
      headers: {
        Authorization: `Bearer ${process.env.YELP_API_KEY}`,
      },
      params: {
        term: "restaurants",
        location,
        price,
        radius,
        limit: 20,
        sort_by: "best_match",
      },
    });

    const cleaned = yelpResponse.data.businesses.map((b) => ({
      id: b.id,
      name: b.name,
      image_url: b.image_url,
      rating: b.rating,
      location: b.location,
      categories: b.categories,
      review_count: b.review_count,
      url: b.url,
    }));

    console.log(`📦 Returning ${cleaned.length} restaurants`);
    res.json(cleaned);
  } catch (error) {
    console.error("🔥 Yelp API error:", error.response?.data || error.message);
    res.status(500).json({ error: "Yelp API request failed" });
  }
});

// ✅ Serve static frontend files *after* API route
app.use(express.static(path.join(__dirname, "public")));

// ✅ Fallback to index.html for frontend routing
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
