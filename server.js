import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config(); // Load .env variables

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

app.post("/api/yelp", async (req, res) => {
  const { location = "Los Angeles", price = "1,2,3", radius = 8000 } = req.body;

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

    res.json(cleaned);
  } catch (error) {
    console.error("🔥 Yelp API error:", error.response?.data || error.message);
    res.status(500).json({ error: "Yelp API request failed" });
  }
});

app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
});
