function generateCode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

document.getElementById("groupForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const form = e.target;
  const filters = {
    location: form.location.value,
    mealtime: form.mealtime.value,
    distance: form.distance.value,
    price: form.price.value,
    groupSize: parseInt(form.groupSize.value),
  };

  const groupCode = generateCode();
  console.log("🔧 Generated groupCode:", groupCode);

  db.ref("groups/" + groupCode)
    .set({
      filters: filters,
      createdAt: new Date().toISOString(),
    })
    .then(() => {
      console.log("✅ Group created:", groupCode);
      document.getElementById("groupCode").textContent = groupCode;
      document.getElementById("groupResult").style.display = "block";

      // ✅ Trigger Yelp fetch
      fetchRestaurantsAndSave(groupCode, filters);

      // ✅ TEMP: Manual test to confirm backend connection
      fetch("/test-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Testing backend connection" }),
      })
        .then(res => res.text())
        .then(data => console.log("🧪 /test-log success:", data))
        .catch(err => console.error("❌ /test-log failed:", err));
    })
    .catch((error) => {
      alert("❌ Error creating group: " + error.message);
    });
});

async function fetchRestaurantsAndSave(groupCode, filters) {
  const radiusMiles = parseInt(filters.distance || "5");
  const radiusMeters = Math.min(radiusMiles * 1609, 40000);
  const requestBody = {
    location: filters.location,
    price: filters.price,
    radius: radiusMeters,
  };

  console.log("📦 Sending Yelp request:", requestBody);

  try {
    const response = await fetch("/api/yelp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    console.log("🧾 Yelp API Status:", response.status);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error("Yelp request failed: " + errText);
    }

    const restaurants = await response.json();
    console.log("🍴 Yelp returned:", restaurants.length, "restaurants");

    await db.ref("groups/" + groupCode + "/restaurants").set(restaurants);
    console.log("✅ Saved restaurants to Firebase");
  } catch (error) {
    console.error("🔥 Yelp API error:", error.message);
  }
}
