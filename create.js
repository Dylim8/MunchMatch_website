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

  // Save to Firebase
  db.ref("groups/" + groupCode)
    .set({
      filters: filters,
      createdAt: new Date().toISOString(),
    })
    .then(() => {
      console.log("Group created:", groupCode);
      document.getElementById("groupCode").textContent = groupCode;
      document.getElementById("groupResult").style.display = "block";
    })
    .catch((error) => {
      alert("Error creating group: " + error.message);
    });
});
