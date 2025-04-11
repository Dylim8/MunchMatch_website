function showMatchScreen(restaurant) {
  document.querySelector(".swipe-section").style.display = "none";
  const matchDiv = document.getElementById("matchScreen");
  document.getElementById("matchRestaurantName").textContent = restaurant.name;
  document.getElementById("viewOnYelp").href = restaurant.url;
  matchDiv.style.display = "block";
}
