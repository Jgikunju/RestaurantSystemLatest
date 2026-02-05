import React, { useState, useEffect, useMemo, useCallback } from "react";
import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";
import {
  getFirestore,
  collection,
  query,
  onSnapshot,
  doc,
  updateDoc,
  addDoc,
  serverTimestamp,
  limit,
  writeBatch,
  runTransaction,
  orderBy,
} from "firebase/firestore";

// --- CONFIGURATION ---
const firebaseConfig = {
  apiKey: "AIzaSyCeVWwJPMt7NUaVLUBrnUhiqjMtZmqh8kk",
  authDomain: "smartserve-demo.firebaseapp.com",
  projectId: "smartserve-demo",
  storageBucket: "smartserve-demo.firebasestorage.app",
  messagingSenderId: "411048389059",
  appId: "1:411048389059:web:23ba5d7cd33dc9a3137576",
  measurementId: "G-SCJSJCK38V",
};

const appId = "smartserve-demo-v1";

// --- HELPER: DYNAMIC PRICING PARSER ---
const getModifierPriceImpact = (optionString) => {
  if (typeof optionString !== "string") return 0;
  const match = optionString.match(/\(([+-])\s*KSh\s*(\d+)\)/i);
  if (match) {
    const sign = match[1] === "+" ? 1 : -1;
    return sign * parseInt(match[2], 10);
  }
  return 0;
};

const formatOrderDate = (dateObj) => {
  if (!dateObj) return "";
  const now = new Date();
  const isToday =
    dateObj.getDate() === now.getDate() &&
    dateObj.getMonth() === now.getMonth() &&
    dateObj.getFullYear() === now.getFullYear();
  if (isToday)
    return `Today, ${dateObj.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  return dateObj.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

// --- HELPER: CSV Downloader ---
const downloadCSV = (data, filename = "report.csv") => {
  const BOM = "\uFEFF";
  const csvContent = data
    .map((row) =>
      row.map((val) => `"${val.toString().replace(/"/g, '""')}"`).join(",")
    )
    .join("\n");

  const blob = new Blob([BOM + csvContent], {
    type: "text/csv;charset=utf-8;",
  });

  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};

// --- CONSTANTS & SEED DATA (v41) ---
const STATUS_FLOW = {
  PLACED: { label: "Order Placed", color: "bg-yellow-500", next: "ACCEPTED" },
  ACCEPTED: {
    label: "Kitchen Accepted",
    color: "bg-blue-500",
    next: "PREPARING",
  },
  PREPARING: { label: "Cooking", color: "bg-indigo-500", next: "READY" },
  READY: { label: "Ready for You!", color: "bg-green-500", next: "SERVED" },
  SERVED: { label: "Enjoy!", color: "bg-gray-400", next: null },
};
const TEST_WAIT_TIME_SECONDS = 5;
const LATE_ORDER_THRESHOLD_SECONDS = 10;
const LATE_SERVICE_THRESHOLD_SECONDS = 5;

const SERVICE_OPTIONS = [
  "💧 Glass of House Water",
  "🧻 Napkins / Tissues",
  "🍴 Cutlery Request",
  "🧂 Salt & Pepper",
  "🌶️ Chilli / Hot Sauce",
  "🧽 Clean Table",
  "🧴 Sanitizer",
  "👋 Send Waiter",
];

const INITIAL_INCIDENTS = [
  {
    id: 1,
    type: "security",
    text: "Suspicious guests at entrance",
    table: "N/A",
    time: "14:10",
    status: "active",
  },
  {
    id: 2,
    type: "upsell",
    text: "Table 7 idle for 20 mins - Approach for drinks",
    table: "7",
    time: "14:15",
    status: "active",
  },
  {
    id: 3,
    type: "urgent",
    text: "Drunk/unruly customer. Approach cautiously.",
    table: "8",
    time: "14:22",
    status: "active",
  },
];

const INITIAL_STAFF = [
  { name: "John D.", role: "Server", status: "ON BREAK (Unwell)", tables: [] },
  {
    name: "Mary K.",
    role: "Server",
    status: "ACTIVE",
    tables: ["9", "8", "4"],
  },
  { name: "Anthony M.", role: "Server", status: "ACTIVE", tables: ["7"] },
  { name: "Chef Michael", role: "Head Chef", status: "ACTIVE", tables: [] },
];

const SEED_MENU = [
  {
    id: "b1",
    name: "Full Java Breakfast Combo",
    price: 1360,
    category: "Breakfast",
    stock: 50,
    foodCost: 500,
    imageUrl: "https://placehold.co/600x400/FFF0E6/333?text=Full+Breakfast",
    description:
      "Two eggs, sausage, toast, baked beans, homefries + single hot beverage or small fresh juice.",
    tags: ["popular"],
    modifiers: [
      {
        label: "Eggs Style",
        type: "select",
        options: [
          "Scrambled",
          "Fried (Over Easy)",
          "Fried (Sunny Side Up)",
          "Poached",
          "Boiled",
          "No Eggs (- KSh 50)",
        ],
      },
      {
        label: "Protein Choice",
        type: "select",
        options: ["Beef Sausage", "Pork Sausage", "No Sausage (- KSh 100)"],
      },
      {
        label: "Toast: Bread Type",
        type: "select",
        options: ["White Bread", "Brown Bread", "No Toast (- KSh 50)"],
      },
      {
        label: "Toast: Preparation",
        type: "select",
        options: [
          "Toasted (Standard)",
          "Butter Glazed Toasted (+ KSh 30)",
          "Plain (Untoasted)",
        ],
      },
      {
        label: "Toast: Accompaniments",
        type: "multiselect",
        options: [
          "Honey on side (+ KSh 20)",
          "Jam on side (+ KSh 20)",
          "Butter on side",
        ],
      },
      {
        label: "Add Extras",
        type: "multiselect",
        options: [
          "Extra 2 Eggs (+ KSh 120)",
          "Extra 2 Sausages (+ KSh 250)",
          "Extra Bacon (+ KSh 200)",
        ],
      },
    ],
  },
  {
    id: "n_steak",
    name: "Steak & Eggs",
    price: 1260,
    category: "Breakfast",
    stock: 15,
    foodCost: 800,
    imageUrl: "https://placehold.co/600x400/331a00/FFF?text=Steak+%26+Eggs",
    tags: ["chef_choice"],
    description:
      "Tenderized steak strip served with two eggs your way and homefries.",
    modifiers: [
      {
        label: "Egg Style",
        type: "select",
        options: ["Fried (Sunny Side Up)", "Scrambled", "Poached"],
      },
      {
        label: "Steak Doneness",
        type: "select",
        options: ["Medium Rare", "Medium", "Well Done"],
      },
    ],
  },
  {
    id: "t_kenyan",
    name: "Kenyan Tea",
    price: 300,
    category: "Drinks",
    stock: 100,
    foodCost: 50,
    imageUrl: "https://placehold.co/600x400/993300/FFF?text=Kenyan+Tea",
    tags: ["quick"],
    description: "Classic Kenyan brewed tea.",
    modifiers: [
      {
        label: "Preparation",
        type: "select",
        options: ["White (with milk)", "Black (no milk)"],
      },
      {
        label: "Strength",
        type: "select",
        options: ["Medium", "Strong (+ KSh 20)", "Mild"],
      },
      {
        label: "Sugar",
        type: "select",
        options: ["No Sugar", "1 Teaspoon", "2 Teaspoons"],
      },
      {
        label: "Add-ons",
        type: "multiselect",
        options: ["Extra Tea Bag (+ KSh 30)", "Lemon Slice (+ KSh 10)"],
      },
    ],
  },
  {
    id: "c_house",
    name: "House Coffee",
    price: 320,
    category: "Drinks",
    stock: 100,
    foodCost: 60,
    imageUrl: "https://placehold.co/600x400/3b2f2f/FFF?text=House+Coffee",
    tags: ["quick"],
    description: "Freshly brewed filter coffee.",
    modifiers: [
      {
        label: "Preparation",
        type: "select",
        options: ["Black", "White (cold milk)", "White (hot milk)"],
      },
      {
        label: "Size",
        type: "select",
        options: ["Regular mug", "Large mug (+ KSh 50)"],
      },
      {
        label: "Strength",
        type: "select",
        options: ["Normal", "Extra Strong (+ KSh 50)"],
      },
    ],
  },
  {
    id: "t_dawa",
    name: "Classic Dawa",
    price: 350,
    category: "Drinks",
    stock: 50,
    foodCost: 100,
    imageUrl: "https://placehold.co/600x400/ffffe6/333?text=Dawa",
    tags: ["quick", "popular"],
    description: "Soothing hot blend of lemon, ginger, and honey.",
    modifiers: [
      {
        label: "Ginger Strength",
        type: "select",
        options: [
          "Normal",
          "Strong (Extra Ginger) (+ KSh 20)",
          "Mild (Less Ginger)",
        ],
      },
      {
        label: "Honey",
        type: "select",
        options: ["Normal Honey", "Extra Honey (+ KSh 30)", "No Honey"],
      },
    ],
  },
  {
    id: "c3",
    name: "Cappuccino",
    price: 370,
    category: "Drinks",
    stock: 50,
    foodCost: 100,
    imageUrl: "https://placehold.co/600x400/D6CCC2/333?text=Cappuccino",
    tags: ["quick"],
    modifiers: [
      {
        label: "Size",
        type: "select",
        options: ["Single", "Double (+KSh 100)"],
      },
      {
        label: "Milk Choice",
        type: "select",
        options: ["Full Cream", "Skimmed", "Almond (+KSh 80)", "Oat (+KSh 80)"],
      },
      {
        label: "Extras",
        type: "multiselect",
        options: ["Extra Shot (+ KSh 100)"],
      },
    ],
  },
  {
    id: "c_latte",
    name: "Caffe Latte",
    price: 380,
    category: "Drinks",
    stock: 50,
    foodCost: 100,
    imageUrl: "https://placehold.co/600x400/EADDCA/333?text=Latte",
    tags: ["quick"],
    modifiers: [
      {
        label: "Size",
        type: "select",
        options: ["Single", "Double (+KSh 100)"],
      },
      {
        label: "Milk Choice",
        type: "select",
        options: ["Full Cream", "Skimmed", "Almond (+KSh 80)", "Oat (+KSh 80)"],
      },
      {
        label: "Extras",
        type: "multiselect",
        options: ["Extra Shot (+ KSh 100)"],
      },
    ],
  },
  {
    id: "q_juice",
    name: "Green Detox Juice",
    price: 450,
    category: "Drinks",
    stock: 30,
    foodCost: 180,
    imageUrl: "https://placehold.co/600x400/e6ffe6/333?text=Green+Detox",
    tags: ["quick", "new"],
    description: "Spinach, cucumber, apple, lemon, ginger.",
    modifiers: [
      {
        label: "Ginger Level",
        type: "select",
        options: ["Normal Ginger", "Extra Ginger (+ KSh 30)", "No Ginger"],
      },
      {
        label: "Ice Preference",
        type: "select",
        options: ["Normal Ice", "No Ice", "Extra Ice"],
      },
    ],
  },
  {
    id: "cd_water",
    name: "Mineral Water (500ml)",
    price: 150,
    category: "Drinks",
    stock: 100,
    foodCost: 40,
    imageUrl: "https://placehold.co/600x400/e0f7fa/333?text=Water",
    tags: ["quick"],
    modifiers: [
      {
        label: "Temperature",
        type: "select",
        options: ["Cold", "Room Temperature"],
      },
    ],
  },
  {
    id: "bw1",
    name: "Umami Wagyu Burger",
    price: 1450,
    category: "Burgers",
    stock: 20,
    foodCost: 600,
    imageUrl: "https://placehold.co/600x400/FFE6E6/333?text=Umami+Burger",
    tags: ["popular", "quick"],
    modifiers: [
      { label: "Cook", type: "select", options: ["Medium", "Well Done"] },
      {
        label: "Add-ons",
        type: "multiselect",
        options: [
          "Extra Cheese (+ KSh 150)",
          "Extra Patty (+ KSh 400)",
          "Bacon (+ KSh 200)",
        ],
      },
    ],
  },
];

const seedDatabase = async (db, appId) => {
  if (!db || !appId) return;
  const batch = writeBatch(db);
  SEED_MENU.forEach((item) => {
    const itemRef = doc(db, `artifacts/${appId}/public/data/menu`, item.id);
    batch.set(
      itemRef,
      { ...item, isAvailable: (item.stock || 0) > 0 },
      { merge: true }
    );
  });
  try {
    await batch.commit();
  } catch (error) {
    console.error("Error seeding database:", error);
  }
};

// --- HOOKS ---
const useMenu = (db) => {
  const [menuItems, setMenuItems] = useState([]);
  const [loadingMenu, setLoadingMenu] = useState(true);
  useEffect(() => {
    if (!db || !appId) return;
    const q = query(collection(db, `artifacts/${appId}/public/data/menu`));
    return onSnapshot(
      q,
      (snapshot) => {
        setMenuItems(
          snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
        );
        setLoadingMenu(false);
      },
      (err) => {
        console.error(err);
        setLoadingMenu(false);
      }
    );
  }, [db]);
  return { menuItems, loadingMenu };
};

const useFirestore = (db, auth) => {
  const [orders, setOrders] = useState([]);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUserId(user.uid);
      } else {
        await signInAnonymously(auth);
      }
      setIsAuthReady(true);
    });
  }, [auth]);

  useEffect(() => {
    if (!db || !userId) return;
    const q = query(
      collection(db, `artifacts/${appId}/users/${userId}/orders`),
      orderBy("timePlaced", "desc"),
      limit(50)
    );
    return onSnapshot(q, (snapshot) => {
      setOrders(
        snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
          timePlaced: doc.data().timePlaced?.toDate() || new Date(),
          serviceRequestTime: doc.data().serviceRequestTime?.toDate() || null,
          manualDelayTime: doc.data().manualDelayTime?.toDate() || null,
        }))
      );
    });
  }, [db, userId]);

  const getOrderPath = useCallback(
    (orderId) => doc(db, `artifacts/${appId}/users/${userId}/orders`, orderId),
    [db, userId]
  );

  const updateStockQuantity = async (itemId, newQuantity) => {
    if (!db) return;
    await updateDoc(doc(db, `artifacts/${appId}/public/data/menu`, itemId), {
      stock: newQuantity,
      isAvailable: newQuantity > 0,
    });
  };

  const decreaseStockFromCart = async (cart) => {
    if (!db) return { success: false, error: "No DB" };
    try {
      await runTransaction(db, async (transaction) => {
        const itemsToUpdate = [];
        for (const item of cart) {
          const itemRef = doc(
            db,
            `artifacts/${appId}/public/data/menu`,
            item.id
          );
          const itemDoc = await transaction.get(itemRef);
          if (!itemDoc.exists() || itemDoc.data().stock < 1)
            throw new Error(`Sorry, ${item.name} just ran out of stock!`);
          itemsToUpdate.push({
            ref: itemRef,
            newStock: itemDoc.data().stock - 1,
          });
        }
        itemsToUpdate.forEach(({ ref, newStock }) =>
          transaction.update(ref, {
            stock: newStock,
            isAvailable: newStock > 0,
          })
        );
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  return {
    orders,
    userId,
    isAuthReady,
    getOrderPath,
    updateStockQuantity,
    decreaseStockFromCart,
  };
};

// --- HELPER FUNCTIONS ---
const sendGeneralServiceRequest = async (db, userId, appId, requestType) => {
  if (!db || !userId) return;
  await addDoc(collection(db, `artifacts/${appId}/users/${userId}/orders`), {
    status: "ACCEPTED",
    table: "General Request",
    serviceRequest: requestType,
    items: [],
    timePlaced: serverTimestamp(),
    serviceRequestTime: serverTimestamp(),
    waiterName: "General Service",
  });
};

// --- COMPONENTS ---
const LoadingScreen = () => (
  <div className="flex h-screen items-center justify-center bg-gray-900 text-white font-medium tracking-widest">
    SMARTSERVE LOADING
  </div>
);
const Icon = ({ path, className = "w-6 h-6" }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      d={path}
    ></path>
  </svg>
);
const StarRating = ({
  rating,
  setRating,
  readOnly = false,
  size = "w-10 h-10",
}) => (
  <div className="flex space-x-2">
    {[1, 2, 3, 4, 5].map((star) => (
      <button
        key={star}
        onClick={() => !readOnly && setRating(star)}
        className={`${readOnly ? "cursor-default" : "focus:outline-none"}`}
        disabled={readOnly}
      >
        <svg
          className={`${size} transition-colors ${
            rating >= star
              ? "text-yellow-400"
              : "text-gray-300 hover:text-yellow-300"
          }`}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.286 3.963a1 1 0 00.95.69h4.168c.969 0 1.371 1.24.588 1.81l-3.372 2.45a1 1 0 00-.364 1.118l1.287 3.963c.3.921-.755 1.688-1.54 1.118l-3.372-2.45a1 1 0 00-1.176 0l-3.372 2.45c-.784.57-1.838-.197-1.54-1.118l1.287-3.963a1 1 0 00-.364-1.118L2.09 9.39c-.783-.57-.38-1.81.588-1.81h4.168a1 1 0 00.95-.69l1.286-3.963z" />
        </svg>
      </button>
    ))}
  </div>
);

// --- MOCK AI ANALYSIS ENGINE ---
const getSimulatedAIInsight = (feedback) => {
  if (!feedback) return null;
  const insights = [];
  if (feedback.foodRating <= 3)
    insights.push(
      "Consistency Alert: Multiple low food ratings this hour. Check line 2."
    );
  if (feedback.serviceRating <= 3)
    insights.push(
      "Operational Alert: Service speed flagged. Consider reassigning float staff."
    );
  if (feedback.generalComment?.toLowerCase().includes("cold"))
    insights.push(
      "Quality Control: Temperature complaints detected. Verify heat lamp function."
    );
  if (feedback.generalComment?.toLowerCase().includes("salt"))
    insights.push("Recipe Alert: Check seasoning levels on main station.");
  if (insights.length > 0) return insights[0];
  if (feedback.foodRating === 5 && feedback.serviceRating === 5)
    return "Positive Sentiment: Staff recognized for excellence. Consider reward.";
  return null;
};

// --- CUSTOMER VIEWS ---
const CustomerHomeScreen = ({
  setView,
  pastOrders,
  onLoadOrder,
  menuItems,
  setOrderType,
  onItemSelect,
  pendingFeedbackOrder,
  onStartFeedback,
  onDismissFeedback,
  hasActiveOrder,
  addToCart,
  onGeneralServiceRequest,
}) => {
  const quickItems = menuItems.filter((i) => i.tags?.includes("quick"));
  const newItems = menuItems.filter((i) => i.tags?.includes("new"));
  const popularItems = menuItems.filter((i) => i.tags?.includes("popular"));
  const [showServiceMenu, setShowServiceMenu] = useState(false);

  const handleSurpriseMe = () => {
    const mealOptions = menuItems.filter((i) =>
      ["Breakfast", "Burgers", "Lunch"].includes(i.category)
    );
    const drinkOptions = menuItems.filter((i) => i.category === "Drinks");
    if (mealOptions.length === 0 || drinkOptions.length === 0) {
      alert("Menu not ready for surprises yet!");
      return;
    }
    const bestMeals = mealOptions.filter(
      (i) => i.tags?.includes("chef_choice") || i.tags?.includes("popular")
    );
    const mealPool = bestMeals.length > 0 ? bestMeals : mealOptions;
    const randomMeal = mealPool[Math.floor(Math.random() * mealPool.length)];
    const bestDrinks = drinkOptions.filter((i) => i.tags?.includes("popular"));
    const drinkPool = bestDrinks.length > 0 ? bestDrinks : drinkOptions;
    const randomDrink = drinkPool[Math.floor(Math.random() * drinkPool.length)];

    const getDefaultMods = (item) => {
      const mods = {};
      if (item.modifiers)
        item.modifiers.forEach((m) => {
          mods[m.label] = m.type === "multiselect" ? [] : m.options[0];
        });
      return mods;
    };

    addToCart(
      randomMeal,
      getDefaultMods(randomMeal),
      randomMeal.price,
      "✨ Surprise Me Selection!",
      true
    ); // stay on page
    addToCart(
      randomDrink,
      getDefaultMods(randomDrink),
      randomDrink.price,
      "✨ Surprise Me Selection!",
      false
    ); // go to home/cart
    alert(
      `🎲 Chef's Surprise:\n${randomMeal.name} & ${randomDrink.name}\nadded to your cart!`
    );
    setView("cart");
  };

  const handleHomeServiceRequest = (type) => {
    onGeneralServiceRequest(type);
    setShowServiceMenu(false);
    alert("Staff notified! 🔔");
  };

  return (
    <div className="pb-32 bg-gray-50 min-h-full font-sans relative">
      <div className="bg-indigo-900 text-white p-8 rounded-b-[40px] shadow-xl mb-8 relative overflow-hidden">
        <div className="flex justify-between items-center mb-2">
          <h2 className="text-4xl font-extrabold">Good morning! ☀️</h2>
        </div>
        <p className="text-indigo-200 text-lg font-medium">
          How would you like to order today?
        </p>
      </div>

      <div className="px-6 space-y-8">
        {pendingFeedbackOrder && (
          <div className="relative bg-gradient-to-r from-indigo-600 to-blue-500 p-5 rounded-3xl shadow-lg text-white animate-in slide-in-from-top duration-700">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDismissFeedback(pendingFeedbackOrder.id);
              }}
              className="absolute top-3 right-3 bg-white/30 p-2 rounded-full hover:bg-white/50 transition z-10"
            >
              <Icon
                path="M6 18L18 6M6 6l12 12"
                className="w-5 h-5 text-white font-bold"
              />
            </button>
            <div
              onClick={() => onStartFeedback(pendingFeedbackOrder)}
              className="cursor-pointer active:scale-95 transition pr-10"
            >
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h3 className="font-black text-lg leading-tight">
                    Rate your visit from
                  </h3>
                  <p className="text-indigo-200 font-medium">
                    {formatOrderDate(pendingFeedbackOrder.timePlaced)}
                  </p>
                </div>
              </div>
              <p className="text-sm font-medium opacity-90">
                Served by {pendingFeedbackOrder.waiterName} • Chef{" "}
                {pendingFeedbackOrder.chefName}
              </p>
              <div className="mt-3 inline-flex items-center bg-white/20 px-4 py-2 rounded-full text-sm font-bold">
                <Icon
                  path="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                  className="w-4 h-4 mr-2"
                />{" "}
                Rate Now
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <button
            onClick={() => {
              setOrderType("DINE_IN");
              setView("categories");
            }}
            className="p-6 bg-white rounded-3xl shadow-sm flex flex-col items-center text-indigo-900 hover:bg-indigo-50 transition active:scale-95 border border-indigo-50/50"
          >
            <Icon
              path="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
              className="w-10 h-10 mb-3 text-indigo-600"
            />
            <span className="font-black text-lg">Eat Here</span>
          </button>
          <button
            onClick={() => {
              setOrderType("TAKEAWAY");
              setView("categories");
            }}
            className="p-6 bg-white rounded-3xl shadow-sm flex flex-col items-center text-indigo-900 hover:bg-indigo-50 transition active:scale-95 border border-indigo-50/50"
          >
            <Icon
              path="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
              className="w-10 h-10 mb-3 text-indigo-600"
            />
            <span className="font-black text-lg">Take Away</span>
          </button>
          <button
            onClick={() => setView("quick_menu")}
            className="p-6 bg-white rounded-3xl shadow-sm flex flex-col items-center text-indigo-900 hover:bg-green-50 transition active:scale-95 border border-green-50/50"
          >
            <span className="text-4xl mb-2">⚡</span>
            <span className="font-black text-lg">Quick Eats</span>
          </button>
          <button
            onClick={handleSurpriseMe}
            className="p-6 bg-gradient-to-br from-purple-500 to-indigo-600 text-white rounded-3xl shadow-lg flex flex-col items-center transition active:scale-95"
          >
            <span className="text-4xl mb-2">🎲</span>
            <span className="font-black text-lg">Surprise Me</span>
          </button>
        </div>

        <div className="relative">
          <button
            onClick={() => setShowServiceMenu(!showServiceMenu)}
            className="w-full p-4 bg-white rounded-3xl shadow-sm flex items-center justify-center text-indigo-900 hover:bg-orange-50 transition active:scale-95 border border-orange-100/50 font-black text-lg"
          >
            <span className="text-2xl mr-2">🔔</span> Call Server
          </button>
          {showServiceMenu && (
            <div className="absolute bottom-full left-0 right-0 mb-2 bg-white rounded-3xl shadow-2xl border p-3 z-50 animate-in slide-in-from-bottom-4 grid grid-cols-2 gap-2 w-full">
              {SERVICE_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => handleHomeServiceRequest(opt)}
                  className="text-left p-3 hover:bg-indigo-50 rounded-xl font-medium text-gray-700 text-sm border border-gray-50"
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>

        {quickItems.length > 0 && (
          <div>
            <h3 className="text-xl font-black text-gray-800 mb-4 flex items-center">
              ⚡ Quick Grab
            </h3>
            <div className="flex space-x-5 overflow-x-auto pb-6 no-scrollbar snap-x pl-1">
              {quickItems.map((item) => (
                <div
                  key={item.id}
                  onClick={() => onItemSelect(item)}
                  className="flex-none w-48 snap-start bg-white rounded-3xl shadow-sm overflow-hidden active:scale-95 transition cursor-pointer border border-gray-100"
                >
                  <img
                    src={item.imageUrl}
                    className="w-full h-32 object-cover"
                    alt={item.name}
                  />
                  <div className="p-4">
                    <h4 className="font-bold text-gray-900 truncate text-lg">
                      {item.name}
                    </h4>
                    <p className="text-green-600 font-black">
                      KSh {item.price}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {pastOrders && pastOrders.length > 0 && (
          <div>
            <h3 className="text-xl font-black text-gray-800 mb-4">
              🔄 Order Again
            </h3>
            <div className="space-y-3">
              {pastOrders.map((order) => (
                <div
                  key={order.id}
                  className="bg-white p-5 rounded-2xl border border-gray-200 flex justify-between items-center shadow-sm"
                >
                  <div className="flex-1">
                    <p className="font-bold text-indigo-900 text-lg">
                      {order.items.length} item(s) &bull; KSh {order.total}
                    </p>
                    <p className="text-sm text-gray-400 truncate w-56">
                      {order.items.map((i) => i.name).join(", ")}
                    </p>
                  </div>
                  <button
                    onClick={() => onLoadOrder(order)}
                    className="px-5 py-3 bg-indigo-100 text-indigo-700 rounded-xl font-bold text-sm hover:bg-indigo-200"
                  >
                    Reorder
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {hasActiveOrder && (
        <div className="fixed bottom-0 left-0 right-0 bg-indigo-900/95 backdrop-blur-md text-indigo-200 p-4 text-center text-sm font-medium z-50 animate-in slide-in-from-bottom">
          ℹ️ Feedback for your current order will be available after your meal.
        </div>
      )}
    </div>
  );
};

const CustomerQuickMenu = ({ setView, setItem, menuItems }) => {
  const quickItems = menuItems.filter((i) => i.tags?.includes("quick"));
  return (
    <div className="p-6 bg-gray-50 min-h-full">
      <button
        onClick={() => setView("home")}
        className="text-indigo-600 mb-8 flex items-center font-bold bg-white px-5 py-3 rounded-full shadow-sm w-fit"
      >
        <Icon path="M15 19l-7-7 7-7" className="w-5 h-5 mr-2" /> Home
      </button>
      <h2 className="text-4xl font-black mb-2 text-indigo-900">
        ⚡ Quick Eats
      </h2>
      <p className="text-gray-600 mb-8">Ready in 10 minutes or less.</p>
      <div className="grid grid-cols-2 gap-4">
        {quickItems.map((item) => (
          <div
            key={item.id}
            onClick={() => {
              setItem(item);
              setView("detail");
            }}
            className="bg-white rounded-3xl shadow-sm overflow-hidden active:scale-95 transition cursor-pointer border border-gray-100"
          >
            <img
              src={item.imageUrl}
              className="w-full h-32 object-cover"
              alt={item.name}
            />
            <div className="p-4">
              <h4 className="font-bold text-gray-900 truncate">{item.name}</h4>
              <p className="text-green-600 font-black">KSh {item.price}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const CustomerMenuCategories = ({ setView, setCategory, menuItems }) => {
  const categories = [...new Set(menuItems.map((i) => i.category))];
  return (
    <div className="p-6 min-h-full bg-gray-50">
      <button
        onClick={() => setView("home")}
        className="text-indigo-600 mb-8 flex items-center font-bold bg-white px-5 py-3 rounded-full shadow-sm w-fit"
      >
        <Icon path="M15 19l-7-7 7-7" className="w-5 h-5 mr-2" /> Home
      </button>
      <h2 className="text-4xl font-black mb-8 text-indigo-900">Menu</h2>
      <div className="grid grid-cols-1 gap-4">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => {
              setCategory(cat);
              setView("menu");
            }}
            className="p-6 bg-white rounded-3xl shadow-sm text-xl font-bold text-indigo-900 hover:bg-indigo-50 transition text-left flex justify-between items-center border border-gray-100"
          >
            <span>{cat}</span>
            <Icon path="M9 5l7 7-7 7" className="w-6 h-6 text-gray-300" />
          </button>
        ))}
      </div>
    </div>
  );
};

const CustomerMenuList = ({
  category,
  setView,
  setItem,
  activeOrder,
  menuItems,
}) => (
  <div className="p-6 bg-gray-50 min-h-full">
    <button
      onClick={() => setView("categories")}
      className="text-indigo-600 mb-8 flex items-center font-bold bg-white px-5 py-3 rounded-full shadow-sm w-fit"
    >
      <Icon path="M15 19l-7-7 7-7" className="w-5 h-5 mr-2" /> Categories
    </button>
    <h2 className="text-4xl font-black mb-8 text-indigo-900">{category}</h2>
    <div className="space-y-6">
      {menuItems
        .filter((i) => i.category === category)
        .map((item) => (
          <div
            key={item.id}
            className="bg-white rounded-[30px] shadow-sm overflow-hidden border border-gray-100"
          >
            <img
              src={item.imageUrl}
              alt={item.name}
              className="w-full h-48 object-cover"
            />
            <div className="p-6">
              <div className="flex justify-between items-start mb-3">
                <h3 className="font-black text-2xl text-gray-900">
                  {item.name}
                </h3>
                <p className="text-green-600 font-black text-xl">
                  KSh {item.price}
                </p>
              </div>
              <p className="text-gray-500 mb-6 text-lg leading-relaxed">
                {item.description}
              </p>
              <button
                disabled={!!activeOrder || item.stock < 1}
                onClick={() => {
                  setItem(item);
                  setView("detail");
                }}
                className={`w-full py-4 rounded-2xl text-white font-bold text-lg shadow-lg ${
                  !!activeOrder || item.stock < 1
                    ? "bg-gray-400"
                    : "bg-indigo-600 hover:bg-indigo-700 active:scale-95 transition"
                }`}
              >
                {item.stock > 0 ? "Customize & Add" : "Sold Out"}
              </button>
            </div>
          </div>
        ))}
    </div>
  </div>
);

const CustomerItemDetail = ({
  item,
  setView,
  addToCart,
  menuItems,
  initialMods = null,
  initialNote = "",
  isEditing = false,
}) => {
  const [mods, setMods] = useState(initialMods || {});
  const [specialRequest, setSpecialRequest] = useState(initialNote || "");
  const [toastMsg, setToastMsg] = useState(null);

  useEffect(() => {
    if (item?.modifiers && !initialMods) {
      const defaults = {};
      item.modifiers.forEach((m) => {
        defaults[m.label] = m.type === "multiselect" ? [] : m.options[0];
      });
      setMods(defaults);
    }
  }, [item, initialMods]);

  const currentPrice = useMemo(() => {
    if (!item) return 0;
    let total = item.price;
    Object.values(mods)
      .flat()
      .forEach((opt) => (total += getModifierPriceImpact(opt)));
    return Math.max(0, total);
  }, [item, mods]);

  if (!item) return null;
  const isDrink = item.category === "Drinks";
  const upsellDrinks = !isDrink
    ? menuItems.filter((i) => i.category === "Drinks").slice(0, 5)
    : [];

  const handleMultiSelectToggle = (label, option) => {
    const currentOptions = mods[label] || [];
    const newOptions = currentOptions.includes(option)
      ? currentOptions.filter((i) => i !== option)
      : [...currentOptions, option];
    setMods({ ...mods, [label]: newOptions });
  };

  const handleQuickAddDrink = (drink) => {
    const defaultMods = {};
    if (drink.modifiers)
      drink.modifiers.forEach((m) => {
        defaultMods[m.label] = m.type === "multiselect" ? [] : m.options[0];
      });
    addToCart(drink, defaultMods, drink.price, "", true);
    setToastMsg(`${drink.name} added!`);
    setTimeout(() => setToastMsg(null), 2000);
  };

  return (
    <div className="bg-white min-h-full pb-48 relative">
      {toastMsg && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 bg-green-600 text-white px-6 py-3 rounded-full font-bold shadow-2xl z-50 animate-bounce">
          {toastMsg}
        </div>
      )}
      <div className="relative">
        <img
          src={item.imageUrl}
          className="w-full h-80 object-cover"
          alt={item.name}
        />
        <button
          onClick={() => setView(isEditing ? "cart" : "menu")}
          className="absolute top-6 left-6 bg-white/90 backdrop-blur-md text-indigo-900 px-5 py-3 rounded-full font-bold flex items-center shadow-lg"
        >
          <Icon path="M15 19l-7-7 7-7" className="w-5 h-5 mr-2" />{" "}
          {isEditing ? "Cancel" : "Back"}
        </button>
      </div>
      <div className="p-8 -mt-12 relative bg-white rounded-t-[40px] shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.2)]">
        <div className="w-16 h-1.5 bg-gray-200 rounded-full mx-auto mb-8"></div>
        <h2 className="text-4xl font-black text-gray-900 leading-tight mb-3">
          {item.name}
        </h2>
        <p className="text-3xl text-green-600 font-black mb-6 transition-all duration-300">
          KSh {currentPrice}
        </p>
        <p className="text-gray-600 mb-10 text-xl leading-relaxed">
          {item.description}
        </p>

        {item.modifiers?.map((mod) => (
          <div key={mod.label} className="mb-10">
            <label className="block font-black text-xl mb-5 text-gray-900">
              {mod.label}
            </label>
            {mod.type === "multiselect" ? (
              <div className="space-y-4">
                {mod.options.map((opt) => {
                  const isSelected = mods[mod.label]?.includes(opt);
                  return (
                    <div
                      key={opt}
                      onClick={() => handleMultiSelectToggle(mod.label, opt)}
                      className={`flex items-center p-5 rounded-2xl border-2 cursor-pointer transition-all ${
                        isSelected
                          ? "bg-indigo-50 border-indigo-600 shadow-md"
                          : "bg-white border-gray-100"
                      }`}
                    >
                      <div
                        className={`w-7 h-7 rounded-md border-2 mr-4 flex items-center justify-center ${
                          isSelected
                            ? "bg-indigo-600 border-indigo-600"
                            : "border-gray-300"
                        }`}
                      >
                        {isSelected && (
                          <Icon
                            path="M5 13l4 4L19 7"
                            className="w-4 h-4 text-white"
                          />
                        )}
                      </div>
                      <span
                        className={`font-bold text-lg ${
                          isSelected ? "text-indigo-900" : "text-gray-700"
                        }`}
                      >
                        {opt}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="relative">
                <select
                  className="w-full p-6 bg-gray-50 border-2 border-gray-100 rounded-2xl text-xl font-bold text-gray-800 appearance-none"
                  value={mods[mod.label] || ""}
                  onChange={(e) =>
                    setMods({ ...mods, [mod.label]: e.target.value })
                  }
                >
                  {mod.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
                <Icon
                  path="M19 9l-7 7-7-7"
                  className="absolute right-6 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none w-6 h-6"
                />
              </div>
            )}
          </div>
        ))}

        <div className="mb-10">
          <label className="block font-black text-xl mb-5 text-gray-900">
            Special Requests
          </label>
          <textarea
            className="w-full p-5 bg-gray-50 border-2 border-gray-100 rounded-2xl text-lg font-medium focus:border-indigo-500 focus:ring-0 transition"
            placeholder="e.g., Extra hot, allergy info..."
            rows="3"
            value={specialRequest}
            onChange={(e) => setSpecialRequest(e.target.value)}
          />
        </div>

        {upsellDrinks.length > 0 && (
          <div className="mt-12 pt-8 border-t-2 border-dashed border-gray-200">
            <h3 className="text-2xl font-black text-gray-900 mb-6">
              You've earned this.
            </h3>
            <div className="flex space-x-4 overflow-x-auto pb-4 no-scrollbar">
              {upsellDrinks.map((drink) => (
                <button
                  key={drink.id}
                  onClick={() => handleQuickAddDrink(drink)}
                  className="flex-none w-40 p-4 bg-gray-50 rounded-3xl border-2 border-gray-100 text-left active:scale-95 transition hover:border-indigo-200"
                >
                  <img
                    src={drink.imageUrl}
                    className="w-full h-24 object-cover rounded-xl mb-3"
                    alt={drink.name}
                  />
                  <p className="font-bold text-gray-900 leading-tight">
                    {drink.name}
                  </p>
                  <p className="text-green-600 font-bold text-sm mt-1">
                    + KSh {drink.price}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="fixed bottom-0 left-0 right-0 p-6 bg-white/90 backdrop-blur-xl border-t shadow-[0_-10px_50px_rgba(0,0,0,0.2)] z-20">
        <div className="max-w-md mx-auto">
          <button
            onClick={() => addToCart(item, mods, currentPrice, specialRequest)}
            className="w-full py-5 bg-indigo-600 text-white font-black rounded-3xl shadow-xl text-xl hover:bg-indigo-700 active:scale-95 transition"
          >
            {isEditing ? "Update Item" : `Add to Order • KSh ${currentPrice}`}
          </button>
        </div>
      </div>
    </div>
  );
};

const CustomerCart = ({
  cart,
  setView,
  remove,
  edit,
  placeOrder,
  orderType,
}) => {
  const total = cart.reduce((sum, i) => sum + i.totalPrice, 0);
  return (
    <div className="p-6 pb-56 bg-gray-50 min-h-full">
      <button
        onClick={() => setView("home")}
        className="text-indigo-600 mb-8 flex items-center font-bold bg-white px-5 py-3 rounded-full shadow-sm w-fit"
      >
        <Icon
          path={
            cart.length > 0 ? "M15 19l-7-7 7-7" : "M12 6v6m0 0v6m0-6h6m-6 0H6"
          }
          className="w-6 h-6 mr-2"
        />
        {cart.length > 0 ? "Continue Shopping" : "Start Shopping"}
      </button>

      <h2 className="text-4xl font-black mb-2 text-indigo-900">Your Order</h2>
      <p className="text-indigo-600 font-black mb-8 uppercase tracking-widest flex items-center">
        {orderType === "TAKEAWAY" ? (
          <>
            <span className="text-2xl mr-2">🥡</span> Take Away
          </>
        ) : (
          <>
            <span className="text-2xl mr-2">🍽️</span> Dine-In
          </>
        )}
      </p>
      {cart.length === 0 ? (
        <div className="text-center text-gray-400 py-24 bg-white rounded-[40px] border-4 border-dashed border-gray-200">
          <Icon
            path="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
            className="w-20 h-20 mx-auto mb-6 text-gray-200"
          />
          <p className="text-2xl font-black mb-2">Your cart is empty</p>
          <p className="text-lg">Time to fill it with deliciousness!</p>
        </div>
      ) : (
        cart.map((item) => (
          <div
            key={item.cartId}
            className="bg-white p-6 rounded-[30px] shadow-sm mb-5 border border-gray-100"
          >
            <div className="flex justify-between mb-4">
              <h3 className="font-black text-xl text-gray-900">{item.name}</h3>
              <p className="font-black text-green-600 text-xl">
                KSh {item.totalPrice}
              </p>
            </div>
            <div className="text-sm text-gray-600 bg-gray-50 p-5 rounded-2xl mb-5 space-y-2">
              {Object.entries(item.modifiers).map(([k, v]) => (
                <p key={k}>
                  <span className="font-bold text-gray-400 uppercase text-xs tracking-wider">
                    {k}:
                  </span>{" "}
                  <span className="text-gray-900 font-bold ml-2">
                    {Array.isArray(v) ? (v.length ? v.join(", ") : "None") : v}
                  </span>
                </p>
              ))}
              {item.specialRequest && (
                <p className="pt-2 mt-2 border-t border-gray-200 text-indigo-700 font-medium italic bg-indigo-50 p-3 rounded-xl">
                  Note: "{item.specialRequest}"
                </p>
              )}
            </div>
            <div className="flex space-x-4">
              <button
                onClick={() => edit(item)}
                className="flex-1 py-3 bg-indigo-50 text-indigo-600 rounded-2xl font-bold flex items-center justify-center"
              >
                ✏️ Edit
              </button>
              <button
                onClick={() => remove(item.cartId)}
                className="flex-1 py-3 bg-red-50 text-red-500 rounded-2xl font-bold"
              >
                Remove
              </button>
            </div>
          </div>
        ))
      )}
      <div className="fixed bottom-0 left-0 right-0 p-8 bg-white border-t shadow-[0_-10px_60px_-15px_rgba(0,0,0,0.3)] rounded-t-[40px] z-30">
        <div className="max-w-md mx-auto">
          <div className="flex justify-between items-baseline mb-6">
            <span className="text-gray-500 font-bold text-xl">
              Total to pay:
            </span>
            <span className="text-5xl font-black text-gray-900">
              KSh {total}
            </span>
          </div>
          <button
            onClick={placeOrder}
            disabled={!cart.length}
            className={`w-full py-6 rounded-3xl text-white font-black text-2xl shadow-xl ${
              cart.length
                ? "bg-green-600 hover:bg-green-700 active:scale-95 transition"
                : "bg-gray-300"
            }`}
          >
            {cart.length ? "Checkout" : "Cart is Empty"}
          </button>
        </div>
      </div>
    </div>
  );
};

const CustomerOrderStatus = ({
  order,
  currentTime,
  confirm,
  onServiceRequest,
}) => {
  const elapsed = Math.floor(
    (currentTime - (order.timePlaced?.getTime() || Date.now())) / 1000
  );

  const initialWaitTime = TEST_WAIT_TIME_SECONDS;

  let remaining;
  if (order.manualDelayMinutes) {
    // FIX: Use manualDelayTime (which IS a Date obj) if it exists
    const delayStartTime = order.manualDelayTime
      ? order.manualDelayTime.getTime()
      : order.timePlaced.getTime() + TEST_WAIT_TIME_SECONDS * 1000;
    const delayElapsed = (currentTime - delayStartTime) / 1000;
    remaining = Math.max(0, order.manualDelayMinutes * 60 - delayElapsed);
  } else {
    remaining = Math.max(0, initialWaitTime - elapsed);
  }

  const isManuallyDelayed =
    order.manualDelayMinutes > 0 &&
    order.status === "PREPARING" &&
    remaining > 0;
  const isAutoLate =
    !isManuallyDelayed &&
    elapsed > LATE_ORDER_THRESHOLD_SECONDS &&
    order.status !== "READY";

  const [showServiceMenu, setShowServiceMenu] = useState(false);
  const handleRequest = (type) => {
    onServiceRequest(order.id, type);
    setShowServiceMenu(false);
    alert("Request sent to staff! 🔔");
  };

  return (
    <div className="p-8 space-y-8 text-center flex flex-col justify-center min-h-[80vh] relative">
      {order.items.length === 0 && order.serviceRequest ? (
        <div className="bg-white p-12 rounded-[50px] shadow-2xl border-4 border-orange-200 relative overflow-hidden">
          <h2 className="text-4xl font-black text-orange-500 mb-4">
            Staff Notified!
          </h2>
          <p className="text-2xl text-gray-700 font-bold">
            {order.serviceRequest}
          </p>
          <p className="text-gray-500 mt-4">
            Someone will be with you shortly.
          </p>
        </div>
      ) : (
        <>
          <div>
            <h2 className="text-5xl font-black text-indigo-900 mb-4">
              You're all set!
            </h2>
            <p className="text-gray-500 text-xl font-bold">
              Order #{order.id.substring(0, 4)} •{" "}
              <span className="text-indigo-600">
                {order.orderType === "TAKEAWAY"
                  ? "Take Away 🥡"
                  : `Table ${order.table} 🍽️`}
              </span>
            </p>
          </div>

          {isManuallyDelayed ? (
            <div className="bg-orange-100 p-6 rounded-3xl text-orange-800 text-center font-medium border-2 border-orange-200">
              <p className="font-black text-lg">Things are a bit backed up!</p>
              <p className="mb-4">
                Chef {order.chefName} is working on it and it will be ready in
                about:
              </p>
              {/* FIX: Correctly format remaining time */}
              <p className="text-6xl font-black text-orange-600 tabular-nums">
                {Math.floor(remaining / 60)}:
                {(Math.floor(remaining) % 60).toString().padStart(2, "0")}
              </p>
            </div>
          ) : (
            <div className="bg-white p-12 rounded-[50px] shadow-2xl border-4 border-indigo-50 relative overflow-hidden">
              <div className="absolute top-0 left-0 h-3 bg-indigo-100 w-full">
                <div
                  className="h-full bg-indigo-600 transition-all duration-1000 ease-linear"
                  style={{
                    width: `${Math.min(
                      100,
                      (elapsed / initialWaitTime) * 100
                    )}%`,
                  }}
                ></div>
              </div>
              <p className="text-indigo-900 font-black text-lg uppercase tracking-widest mb-2">
                Estimated Wait
              </p>
              <p className="text-8xl font-black text-indigo-600 tabular-nums tracking-tighter">
                0:{(Math.floor(remaining) % 60).toString().padStart(2, "0")}
              </p>
            </div>
          )}

          <div
            className={`py-6 px-8 rounded-3xl font-black text-white text-3xl shadow-xl transition-all duration-500 transform ${
              STATUS_FLOW[order.status].color
            } ${order.status === "READY" ? "scale-110" : ""}`}
          >
            {STATUS_FLOW[order.status].label}
          </div>

          {isAutoLate && (
            <div className="bg-red-100 p-4 rounded-2xl text-red-700 text-center font-bold animate-pulse">
              Sorry for the delay! We're rushing your order now.
            </div>
          )}

          {order.status !== "READY" && (
            <div className="relative">
              <button
                onClick={() => setShowServiceMenu(!showServiceMenu)}
                className="bg-gray-100 text-indigo-900 px-6 py-3 rounded-full font-bold flex items-center mx-auto hover:bg-gray-200 transition"
              >
                🔔 Call Server
              </button>
              {showServiceMenu && (
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-4 bg-white rounded-2xl shadow-2xl border p-3 w-72 z-50 animate-in slide-in-from-bottom-4 grid grid-cols-2 gap-2">
                  {SERVICE_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      onClick={() => handleRequest(opt)}
                      className="text-left p-2 hover:bg-indigo-50 rounded-xl font-medium text-gray-700 text-sm border border-gray-50"
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {order.status === "READY" && (
            <button
              onClick={confirm}
              className="w-full py-6 bg-green-600 text-white font-black rounded-3xl text-3xl shadow-2xl hover:bg-green-700 animate-bounce"
            >
              {order.orderType === "TAKEAWAY" ? "Collected!" : "Got it!"}
            </button>
          )}
        </>
      )}
    </div>
  );
};

const CustomerFeedbackScreen = ({ order, onSubmit, onSkip, onDismiss }) => {
  const [serviceRating, setServiceRating] = useState(
    order.feedback?.serviceRating || 0
  );
  const [foodRating, setFoodRating] = useState(order.feedback?.foodRating || 0);
  const [itemRatings, setItemRatings] = useState(
    order.feedback?.itemRatings || {}
  );
  const [generalComment, setGeneralComment] = useState(
    order.feedback?.generalComment || ""
  );

  const handleSubmit = () => {
    const feedbackData = {
      serviceRating,
      foodRating,
      itemRatings,
      generalComment,
      waiterName: order.waiterName,
      chefName: order.chefName,
      createdAt: serverTimestamp(),
    };
    onSubmit(feedbackData);
  };

  return (
    <div className="p-6 pb-48 bg-gray-50 min-h-full">
      <h2 className="text-4xl font-black mb-2 text-indigo-900">
        Your Feedback
      </h2>
      <p className="text-gray-600 text-lg mb-8">
        Visit on {formatOrderDate(order.timePlaced)}
      </p>
      <div className="bg-indigo-50 p-5 rounded-3xl mb-8 border border-indigo-100">
        <h3 className="font-bold text-indigo-900 mb-2">Order Summary</h3>
        <ul className="text-indigo-700 space-y-1 text-sm font-medium">
          {order.items.map((item, i) => (
            <li key={i}>• {item.name}</li>
          ))}
        </ul>
      </div>
      <div className="bg-white p-6 rounded-3xl shadow-sm mb-6 border border-gray-100">
        <label className="block font-black text-xl mb-4 text-gray-900">
          Service by {order.waiterName}
        </label>
        <StarRating rating={serviceRating} setRating={setServiceRating} />
      </div>
      <div className="bg-white p-6 rounded-3xl shadow-sm mb-6 border border-gray-100">
        <label className="block font-black text-xl mb-4 text-gray-900">
          Food by {order.chefName}
        </label>
        <StarRating rating={foodRating} setRating={setFoodRating} />
      </div>
      <div className="bg-white p-6 rounded-3xl shadow-sm mb-6 border border-gray-100">
        <label className="block font-black text-xl mb-6 text-gray-900">
          Rate Items
        </label>
        <div className="space-y-6">
          {order.items.map((item, idx) => (
            <div key={idx}>
              <label className="block font-bold text-lg mb-3 text-gray-700">
                {item.name}
              </label>
              <StarRating
                rating={itemRatings[item.name] || 0}
                setRating={(rating) =>
                  setItemRatings((prev) => ({ ...prev, [item.name]: rating }))
                }
              />
            </div>
          ))}
        </div>
      </div>
      <div className="bg-white p-6 rounded-3xl shadow-sm mb-6 border border-gray-100">
        <textarea
          className="w-full p-5 bg-gray-50 border-2 border-gray-100 rounded-2xl text-lg font-medium"
          placeholder="Any other comments?"
          rows="3"
          value={generalComment}
          onChange={(e) => setGeneralComment(e.target.value)}
        />
      </div>
      <div className="fixed bottom-0 left-0 right-0 p-6 bg-white/90 backdrop-blur-xl border-t shadow-2xl z-20">
        <div className="max-w-md mx-auto space-y-3">
          <button
            onClick={handleSubmit}
            className="w-full py-5 bg-indigo-600 text-white font-black rounded-3xl shadow-xl text-xl"
          >
            Submit Feedback
          </button>
          <button
            onClick={() => onDismiss(order.id)}
            className="w-full py-3 bg-transparent text-gray-400 font-bold hover:text-gray-600 transition"
          >
            No Thanks
          </button>
        </div>
      </div>
    </div>
  );
};

const TableSelectionScreen = ({ onSelectTable }) => {
  const [tableNum, setTableNum] = useState("");
  const handleNumPress = (num) => {
    if (tableNum.length < 3) setTableNum(tableNum + num);
  };
  const handleDelete = () => setTableNum(tableNum.slice(0, -1));
  return (
    <div className="p-6 min-h-full bg-gray-50 flex flex-col justify-center">
      <h2 className="text-3xl font-black text-center text-indigo-900 mb-2">
        Where are you sitting?
      </h2>
      <p className="text-center text-gray-500 mb-8">
        Check the number on your table
      </p>
      <div className="bg-white p-6 rounded-3xl shadow-lg border-2 border-indigo-50 mb-8 mx-auto w-48">
        <p className="text-center text-gray-400 text-sm font-bold uppercase tracking-widest mb-1">
          TABLE NUMBER
        </p>
        <p className="text-center text-6xl font-black text-indigo-600 h-16">
          {tableNum || "_"}
        </p>
      </div>
      <div className="grid grid-cols-3 gap-3 max-w-xs mx-auto">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
          <button
            key={num}
            onClick={() => handleNumPress(num.toString())}
            className="p-5 bg-white rounded-2xl shadow-sm border border-gray-200 text-2xl font-bold text-gray-700 active:bg-gray-100"
          >
            {num}
          </button>
        ))}
        <button
          onClick={() => setTableNum("")}
          className="p-5 bg-red-50 rounded-2xl shadow-sm border border-red-100 text-lg font-bold text-red-500 active:bg-red-100"
        >
          CLR
        </button>
        <button
          onClick={() => handleNumPress("0")}
          className="p-5 bg-white rounded-2xl shadow-sm border border-gray-200 text-2xl font-bold text-gray-700 active:bg-gray-100"
        >
          0
        </button>
        <button
          onClick={handleDelete}
          className="p-5 bg-gray-50 rounded-2xl shadow-sm border border-gray-200 text-xl font-bold text-gray-500 active:bg-gray-100"
        >
          ⌫
        </button>
      </div>
      <button
        onClick={() => tableNum && onSelectTable(tableNum)}
        disabled={!tableNum}
        className={`w-full max-w-xs mx-auto mt-8 py-5 rounded-3xl text-white font-black text-xl shadow-xl transition ${
          tableNum
            ? "bg-green-600 hover:bg-green-700 active:scale-95"
            : "bg-gray-300 cursor-not-allowed"
        }`}
      >
        Confirm Table {tableNum}
      </button>
    </div>
  );
};

// --- CONTAINERS ---
const CustomerAppContainerFixed = ({
  db,
  userId,
  menuItems,
  orders,
  currentTime,
  decreaseStockFromCart,
  getOrderPath,
  setMode,
  isSplit = false,
}) => {
  const [view, setView] = useState("home");
  const [category, setCategory] = useState(null);
  const [orderType, setOrderType] = useState("DINE_IN");
  const [viewingItem, setViewingItem] = useState(null);
  const [editingItem, setEditingItem] = useState(null);
  const [reviewingOrder, setReviewingOrder] = useState(null);
  const [cart, setCart] = useState([]);
  const [feedbackDelayedVisible, setFeedbackDelayedVisible] = useState(false);

  const activeOrder = orders.find((o) => o.status !== "SERVED");
  const pastOrders = orders.filter((o) => o.status === "SERVED").slice(0, 5);
  const pendingFeedbackOrder = useMemo(
    () =>
      orders.find(
        (o) => o.status === "SERVED" && !o.feedback && !o.feedbackSkipped
      ),
    [orders]
  );

  useEffect(() => {
    if (pendingFeedbackOrder && !feedbackDelayedVisible) {
      const timer = setTimeout(() => setFeedbackDelayedVisible(true), 5000);
      return () => clearTimeout(timer);
    }
  }, [pendingFeedbackOrder, feedbackDelayedVisible]);

  const handleLoadOldOrder = (oldOrder) => {
    setOrderType(oldOrder.orderType || "DINE_IN");
    const reconstructedCart = oldOrder.items.map((oldItem) => ({
      ...oldItem,
      originalItem: menuItems.find((mi) => mi.id === oldItem.id),
      totalPrice: oldItem.price,
      cartId: Math.random(),
    }));
    setCart(reconstructedCart);
    setView("cart");
  };

  const handleAddToCart = (
    itemData,
    mods,
    price,
    specialRequest = "",
    stayOnPage = false
  ) => {
    if (editingItem) {
      setCart(
        cart.map((i) =>
          i.cartId === editingItem.cartId
            ? { ...i, modifiers: mods, specialRequest, totalPrice: price }
            : i
        )
      );
      setEditingItem(null);
      setView("cart");
    } else {
      setCart((prevCart) => [
        ...prevCart,
        {
          ...itemData,
          originalItem: itemData,
          modifiers: mods,
          specialRequest,
          totalPrice: price,
          cartId: Math.random(),
        },
      ]);
      if (!stayOnPage) setView("home");
    }
  };

  const handlePlaceOrder = async (selectedTable) => {
    const stockRes = await decreaseStockFromCart(cart);
    if (!stockRes.success) {
      alert(stockRes.error);
      return;
    }
    await addDoc(collection(db, `artifacts/${appId}/users/${userId}/orders`), {
      status: "ACCEPTED",
      table: selectedTable || "TAKEAWAY",
      orderType,
      total: cart.reduce((s, i) => s + i.totalPrice, 0),
      items: cart.map((i) => ({
        id: i.id,
        name: i.name,
        price: i.totalPrice,
        modifiers: i.modifiers,
        specialRequest: i.specialRequest || "",
      })),
      timePlaced: serverTimestamp(),
      manualDelayMinutes: 0,
      waiterName: "John D.",
      chefName: "Chef Michael",
    });
    setCart([]);
    setFeedbackDelayedVisible(false);
    setView("home");
  };

  const handleServiceRequest = async (orderId, requestType) => {
    await updateDoc(getOrderPath(orderId), {
      serviceRequest: requestType,
      serviceRequestTime: serverTimestamp(),
    });
  };
  const handleGeneralServiceRequest = async (requestType) => {
    if (!db || !userId) return;
    await addDoc(collection(db, `artifacts/${appId}/users/${userId}/orders`), {
      status: "ACCEPTED",
      table: "General Request",
      serviceRequest: requestType,
      items: [],
      timePlaced: serverTimestamp(),
      serviceRequestTime: serverTimestamp(),
      waiterName: "General Service",
    });
  };
  const confirmPickup = async () => {
    if (!activeOrder) return;
    setView("home");
    await updateDoc(getOrderPath(activeOrder.id), { status: "SERVED" });
  };
  const handleSubmitFeedback = async (feedbackData) => {
    if (reviewingOrder) {
      await updateDoc(getOrderPath(reviewingOrder.id), {
        feedback: feedbackData,
      });
      setReviewingOrder(null);
      setView("home");
    }
  };
  const handleDismissFeedback = async (orderId) => {
    if (orderId) {
      await updateDoc(getOrderPath(orderId), { feedbackSkipped: true });
      setReviewingOrder(null);
      setView("home");
    }
  };

  return (
    <div
      className={`${
        isSplit ? "w-full h-full" : "max-w-md mx-auto min-h-screen shadow-2xl"
      } bg-gray-50 relative overflow-y-auto font-sans`}
    >
      {activeOrder ? (
        <CustomerOrderStatus
          order={activeOrder}
          currentTime={currentTime}
          confirm={confirmPickup}
          onServiceRequest={handleServiceRequest}
        />
      ) : view === "feedback" ? (
        <CustomerFeedbackScreen
          order={reviewingOrder}
          onSubmit={handleSubmitFeedback}
          onSkip={() => {
            setReviewingOrder(null);
            setView("home");
          }}
          onDismiss={handleDismissFeedback}
        />
      ) : view === "home" ? (
        <CustomerHomeScreen
          setView={setView}
          pastOrders={pastOrders}
          onLoadOrder={handleLoadOldOrder}
          menuItems={menuItems}
          setOrderType={setOrderType}
          onItemSelect={(i) => {
            setViewingItem(i);
            setEditingItem(null);
            setView("detail");
          }}
          pendingFeedbackOrder={
            feedbackDelayedVisible ? pendingFeedbackOrder : null
          }
          onStartFeedback={(order) => {
            setReviewingOrder(order);
            setView("feedback");
          }}
          onDismissFeedback={handleDismissFeedback}
          hasActiveOrder={!!activeOrder}
          addToCart={handleAddToCart}
          onGeneralServiceRequest={handleGeneralServiceRequest}
        />
      ) : view === "categories" ? (
        <CustomerMenuCategories
          setView={setView}
          setCategory={setCategory}
          menuItems={menuItems}
        />
      ) : view === "menu" ? (
        <CustomerMenuList
          category={category}
          setView={setView}
          setItem={(i) => {
            setViewingItem(i);
            setEditingItem(null);
            setView("detail");
          }}
          activeOrder={activeOrder}
          menuItems={menuItems}
        />
      ) : view === "quick_menu" ? (
        <CustomerQuickMenu
          setView={setView}
          setItem={(i) => {
            setViewingItem(i);
            setEditingItem(null);
            setView("detail");
          }}
          menuItems={menuItems}
          activeOrder={activeOrder}
        />
      ) : view === "detail" ? (
        <CustomerItemDetail
          item={editingItem ? editingItem.originalItem : viewingItem}
          initialMods={editingItem ? editingItem.modifiers : null}
          initialNote={editingItem ? editingItem.specialRequest : ""}
          isEditing={!!editingItem}
          setView={setView}
          addToCart={handleAddToCart}
          menuItems={menuItems}
        />
      ) : view === "table_select" ? (
        <TableSelectionScreen onSelectTable={handlePlaceOrder} />
      ) : null}
      {!activeOrder &&
        view !== "feedback" &&
        view !== "table_select" &&
        cart.length > 0 &&
        view !== "detail" &&
        view !== "cart" && (
          <div className="fixed bottom-0 max-w-md w-full p-6 bg-white/80 backdrop-blur-xl border-t shadow-2xl z-30">
            <button
              onClick={() => setView("cart")}
              className="w-full py-4 bg-indigo-900 text-white font-bold rounded-2xl shadow-md hover:bg-indigo-800 transition flex justify-between px-6 text-lg"
            >
              <span>View Cart ({cart.length})</span>
              <span>KSh {cart.reduce((s, i) => s + i.totalPrice, 0)}</span>
            </button>
          </div>
        )}
      {!activeOrder && view === "cart" && (
        <CustomerCart
          cart={cart}
          setView={setView}
          remove={(id) => setCart(cart.filter((i) => i.cartId !== id))}
          edit={(item) => {
            setEditingItem(item);
            setView("detail");
          }}
          placeOrder={() =>
            orderType === "DINE_IN"
              ? setView("table_select")
              : handlePlaceOrder("TAKEAWAY")
          }
          orderType={orderType}
        />
      )}
      {!activeOrder && view !== "feedback" && view !== "table_select" && (
        <button
          onClick={() => setMode(null)}
          className="absolute top-6 right-6 bg-black/30 text-white px-4 py-2 rounded-full text-xs font-black backdrop-blur-md z-50 hover:bg-red-600 transition"
        >
          EXIT DEMO
        </button>
      )}
    </div>
  );
};

const ManagerDashboard = ({
  orders,
  menuItems,
  incidents,
  onResolveIncident,
  currentTime,
}) => {
  const ratings = useMemo(() => {
    const feedback = orders.filter((o) => o.feedback).map((o) => o.feedback);
    const avgService = feedback.length
      ? (
          feedback.reduce((acc, curr) => acc + curr.serviceRating, 0) /
          feedback.length
        ).toFixed(1)
      : "N/A";
    const avgFood = feedback.length
      ? (
          feedback.reduce((acc, curr) => acc + curr.foodRating, 0) /
          feedback.length
        ).toFixed(1)
      : "N/A";
    return { avgService, avgFood, count: feedback.length };
  }, [orders]);

  const allIncidents = useMemo(() => {
    const atRiskOrders = orders
      .filter(
        (o) =>
          o.status === "PREPARING" &&
          !o.manualDelayMinutes &&
          (currentTime - o.timePlaced?.getTime()) / 1000 >
            LATE_ORDER_THRESHOLD_SECONDS
      )
      .map((o) => ({
        id: `late_${o.id}`,
        type: "urgent",
        text: `Order #${o.id.substring(0, 4)} is LATE!`,
        table: o.table,
        time: o.timePlaced.toLocaleTimeString(),
        status: "active",
      }));
    const atRiskService = orders
      .filter(
        (o) =>
          o.serviceRequest &&
          o.serviceRequestTime &&
          (currentTime - o.serviceRequestTime.getTime()) / 1000 >
            LATE_SERVICE_THRESHOLD_SECONDS
      )
      .map((o) => ({
        id: `service_${o.id}`,
        type: "urgent",
        text: `Service Request for ${o.serviceRequest} is LATE!`,
        table: o.table,
        time: o.serviceRequestTime.toLocaleTimeString(),
        status: "active",
      }));
    const manualIncidents = incidents.filter((i) => i.status === "active");
    return [...atRiskOrders, ...atRiskService, ...manualIncidents];
  }, [orders, incidents, currentTime]);

  return (
    <div className="flex-1 overflow-y-auto space-y-6 pr-4">
      <div className="bg-yellow-500 text-gray-900 p-3 rounded-xl font-bold flex items-center animate-pulse-slow">
        <span className="mr-2">📢</span> TODAY: Holiday Traffic Expected.
        Maintain "Clean As You Go".
      </div>
      <div>
        <h2 className="font-black text-2xl sticky top-0 bg-gray-900 py-2 z-10 flex items-center">
          <span className="mr-2">🚨</span> Live Incidents ({allIncidents.length}
          )
        </h2>
        <div className="space-y-3">
          {allIncidents.length === 0 ? (
            <p className="text-gray-500 italic">No active incidents.</p>
          ) : (
            allIncidents.map((incident) => (
              <div
                key={incident.id}
                className={`p-4 rounded-2xl border-l-[8px] flex justify-between items-center ${
                  incident.type === "urgent" || incident.type === "security"
                    ? "bg-red-900/30 border-red-500"
                    : "bg-yellow-900/30 border-yellow-500"
                }`}
              >
                <div>
                  <p className="font-bold text-lg">{incident.text}</p>
                  <p className="text-sm opacity-70">
                    Table: {incident.table} • Time: {incident.time}
                  </p>
                </div>
                <button
                  onClick={() => onResolveIncident(incident.id)}
                  className="bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg font-bold text-sm transition"
                >
                  RESOLVE
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      <div>
        <h2 className="font-black text-2xl py-2 z-10 flex items-center">
          <span className="mr-2">👥</span> Staff Status
        </h2>
        <div className="grid grid-cols-2 gap-4">
          {INITIAL_STAFF.map((staff, idx) => (
            <div
              key={idx}
              className={`p-4 rounded-2xl border-2 ${
                staff.status === "ACTIVE"
                  ? "border-green-500/30 bg-green-900/20"
                  : "border-red-500/30 bg-red-900/20"
              }`}
            >
              <div className="flex justify-between mb-2">
                <span className="font-bold">{staff.name}</span>
                <span
                  className={`text-xs font-black px-2 py-1 rounded-full ${
                    staff.status === "ACTIVE"
                      ? "bg-green-500 text-white"
                      : "bg-red-500 text-white"
                  }`}
                >
                  {staff.status}
                </span>
              </div>
              <p className="text-sm text-gray-400">
                {staff.role} • Tables: {staff.tables.join(", ") || "None"}
              </p>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h2 className="font-black text-2xl py-2 z-10 flex items-center">
          <span className="mr-2">📈</span> Live Performance
        </h2>
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-gray-800 p-5 rounded-2xl text-center border border-gray-700">
            <p className="text-gray-400 text-sm uppercase font-bold mb-1">
              Service Rating
            </p>
            <p className="text-4xl font-black text-blue-400">
              {ratings.avgService}
            </p>
            <p className="text-xs text-gray-500">{ratings.count} reviews</p>
          </div>
          <div className="bg-gray-800 p-5 rounded-2xl text-center border border-gray-700">
            <p className="text-gray-400 text-sm uppercase font-bold mb-1">
              Food Rating
            </p>
            <p className="text-4xl font-black text-green-400">
              {ratings.avgFood}
            </p>
            <p className="text-xs text-gray-500">{ratings.count} reviews</p>
          </div>
          <div className="bg-gray-800 p-5 rounded-2xl text-center border border-gray-700">
            <p className="text-gray-400 text-sm uppercase font-bold mb-1">
              Branch Rank
            </p>
            <p className="text-4xl font-black text-yellow-400">#2</p>
            <p className="text-xs text-gray-500">vs 5 branches</p>
          </div>
        </div>
      </div>
      <div>
        <h2 className="font-black text-2xl py-2 z-10 flex items-center">
          <span className="mr-2">📋</span> EOD Handover Preview
        </h2>
        <div className="bg-gray-800 p-5 rounded-3xl border border-gray-700 text-sm text-gray-300 space-y-2">
          <p>
            • <span className="font-bold text-white">Pending Orders:</span>{" "}
            {orders.filter((o) => o.status !== "SERVED").length}
          </p>
          <p>
            • <span className="font-bold text-white">Low Stock Items:</span>{" "}
            {menuItems.filter((i) => i.stock < 10 && i.stock > 0).length}
          </p>
          <p>
            • <span className="font-bold text-white">Out of Stock:</span>{" "}
            {menuItems.filter((i) => i.stock <= 0).length}
          </p>
          <p>
            • <span className="font-bold text-white">Notes:</span> Quiet lunch
            service. Security incident resolved at 14:30.
          </p>
        </div>
      </div>
    </div>
  );
};

const KitchenStockView = ({ menuItems, updateStock }) => {
  const sortedItems = [...menuItems].sort((a, b) => a.stock - b.stock);
  return (
    <div className="overflow-y-auto flex-1 pr-4 space-y-3">
      {sortedItems.map((i) => {
        let stockColor = "bg-gray-800 border-gray-700";
        let textColor = "text-white";
        if (i.stock <= 0) {
          stockColor = "bg-red-900/30 border-red-600";
          textColor = "text-red-500";
        } else if (i.stock < 20) {
          stockColor = "bg-orange-900/30 border-orange-500";
          textColor = "text-orange-400";
        }
        return (
          <div
            key={i.id}
            className={`flex justify-between p-4 rounded-2xl border-2 items-center ${stockColor}`}
          >
            <span className={`text-lg font-bold ${textColor}`}>
              {i.name} <span className="opacity-70 ml-2">({i.stock})</span>
            </span>
            <div className="flex space-x-1">
              <button
                onClick={() => updateStock(i.id, Math.max(0, i.stock - 1))}
                className="w-12 h-12 bg-red-600 rounded-l-xl font-black text-2xl flex items-center justify-center hover:bg-red-700 transition"
              >
                -
              </button>
              <button
                onClick={() => updateStock(i.id, i.stock + 1)}
                className="w-12 h-12 bg-green-600 rounded-r-xl font-black text-2xl flex items-center justify-center hover:bg-green-700 transition"
              >
                +
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// --- FIX: AnalyticsDashboard ---
const AnalyticsDashboard = ({ orders, menuItems }) => {
  // --- THIS IS THE FIX: Added the 'ratings' calculation ---
  const { totalSales, totalProfit, margin, ratings } = useMemo(() => {
    let totalSales = 0;
    let totalCost = 0;
    const feedback = [];

    orders.forEach((order) => {
      totalSales += order.total || 0;
      if (order.feedback) {
        feedback.push(order.feedback);
      }
      order.items.forEach((item) => {
        const menuItem = menuItems.find((mi) => mi.id === item.id);
        totalCost += menuItem?.foodCost || item.price / 2;
      });
    });

    const totalProfit = totalSales - totalCost;
    const margin =
      totalSales > 0 ? ((totalProfit / totalSales) * 100).toFixed(1) : "0.0";

    const avgService = feedback.length
      ? (
          feedback.reduce((acc, curr) => acc + curr.serviceRating, 0) /
          feedback.length
        ).toFixed(1)
      : "N/A";
    const avgFood = feedback.length
      ? (
          feedback.reduce((acc, curr) => acc + curr.foodRating, 0) /
          feedback.length
        ).toFixed(1)
      : "N/A";
    const calculatedRatings = { avgService, avgFood, count: feedback.length };

    return { totalSales, totalProfit, margin, ratings: calculatedRatings };
  }, [orders, menuItems]);
  // --- END FIX ---

  const salesData = [30, 45, 60, 50, 80, 90, 75, 110];
  const topProfitItems = [
    { name: "Umami Wagyu Burger", profit: "KSh 850", margin: "58.6%" },
    { name: "Steak & Eggs", profit: "KSh 460", margin: "36.5%" },
    { name: "Full Breakfast Combo", profit: "KSh 860", margin: "63.2%" },
  ];
  const marginKillers = [
    { name: "Green Detox Juice", profit: "KSh 270", margin: "40.0%" },
  ];
  const staffLeaderboard = [
    { name: "Mary K.", rating: 4.8 },
    { name: "John D.", rating: 4.5 },
    { name: "Anthony M.", rating: 4.2 },
  ];

  const handleDownloadReport = () => {
    const data = [
      [
        "Order ID",
        "Date",
        "Time",
        "Table",
        "Total Sales",
        "Est. Food Cost",
        "Est. Profit",
        "Item Name",
        "Item Price",
        "Item Category",
        "Service Rating",
        "Food Rating",
        "Comment",
      ],
    ];
    orders.forEach((order) => {
      if (order.items.length > 0) {
        order.items.forEach((item, index) => {
          const menuItem = menuItems.find((mi) => mi.id === item.id);
          const foodCost = menuItem?.foodCost || item.price / 2;
          const profit = item.price - foodCost;
          const orderId = index === 0 ? order.id.substring(0, 6) : "";
          const orderDate =
            index === 0 ? order.timePlaced.toLocaleDateString() : "";
          const orderTime =
            index === 0 ? order.timePlaced.toLocaleTimeString() : "";
          const table = index === 0 ? order.table : "";
          const totalSales = index === 0 ? order.total : "";
          const serviceRating =
            index === 0 ? order.feedback?.serviceRating || "N/A" : "";
          const foodRating =
            index === 0 ? order.feedback?.foodRating || "N/A" : "";
          const comment =
            index === 0
              ? (order.feedback?.generalComment || "").replace(
                  /(\r\n|\n|\r|,)/gm,
                  ";"
                )
              : "";
          data.push([
            orderId,
            orderDate,
            orderTime,
            table,
            totalSales,
            foodCost,
            profit,
            item.name,
            item.price,
            menuItem?.category || "N/A",
            serviceRating,
            foodRating,
            comment,
          ]);
        });
      }
    });
    downloadCSV(
      data,
      `SmartServe_Sales_Report_${new Date().toISOString().split("T")[0]}.csv`
    );
  };

  return (
    <div className="flex-1 overflow-y-auto space-y-6 pr-4">
      <div className="flex justify-between items-center">
        <h2 className="font-black text-2xl z-10">Business Intelligence</h2>
        <button
          onClick={handleDownloadReport}
          className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded-xl flex items-center"
        >
          <Icon
            path="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            className="w-5 h-5 mr-2"
          />{" "}
          Download Excel
        </button>
      </div>
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-gray-800 p-5 rounded-2xl text-center border border-gray-700">
          <p className="text-gray-400 text-sm uppercase font-bold mb-1">
            Total Sales (Today)
          </p>
          <p className="text-4xl font-black text-green-400">KSh {totalSales}</p>
        </div>
        <div className="bg-gray-800 p-5 rounded-2xl text-center border border-gray-700">
          <p className="text-gray-400 text-sm uppercase font-bold mb-1">
            Est. Profit (Today)
          </p>
          <p className="text-4xl font-black text-green-500">
            KSh {totalProfit}
          </p>
        </div>
        <div className="bg-gray-800 p-5 rounded-2xl text-center border border-gray-700">
          <p className="text-gray-400 text-sm uppercase font-bold mb-1">
            Net Margin
          </p>
          <p className="text-4xl font-black text-green-400">{margin}%</p>
        </div>
        <div className="bg-gray-800 p-5 rounded-2xl text-center border border-gray-700">
          <p className="text-gray-400 text-sm uppercase font-bold mb-1">
            Avg. Service Rating
          </p>
          <p className="text-4xl font-black text-blue-400">
            {ratings.avgService}
          </p>
        </div>
      </div>
      <div>
        <h3 className="font-bold text-xl mb-3">Sales Per Hour (Today)</h3>
        <div className="bg-gray-800 p-6 rounded-2xl border border-gray-700 flex items-end h-64 space-x-2">
          {salesData.map((val, i) => (
            <div
              key={i}
              className="flex-1 bg-indigo-600 rounded-t-lg hover:bg-indigo-500 transition-all"
              style={{ height: `${(val / 120) * 100}%` }}
              title={`Hour ${i + 9}: KSh ${val},000`}
            ></div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h3 className="font-bold text-xl mb-3">Menu Performance</h3>
          <div className="bg-gray-800 p-4 rounded-2xl border border-gray-700">
            <h4 className="font-bold text-green-400 mb-2">
              Top Profit Drivers
            </h4>
            {topProfitItems.map((item) => (
              <div
                key={item.name}
                className="text-sm mb-1 flex justify-between"
              >
                <span className="text-gray-200">{item.name}</span>{" "}
                <span className="font-bold text-gray-400">{item.margin}</span>
              </div>
            ))}
            <h4 className="font-bold text-orange-400 mt-6 mb-2">
              Margin Killers
            </h4>
            {marginKillers.map((item) => (
              <div
                key={item.name}
                className="text-sm mb-1 flex justify-between"
              >
                <span className="text-gray-200">{item.name}</span>{" "}
                <span className="font-bold text-orange-400">{item.margin}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="font-bold text-xl mb-3">
            Staff Leaderboard (Avg. Rating)
          </h3>
          <div className="bg-gray-800 p-4 rounded-2xl border border-gray-700 space-y-2">
            {staffLeaderboard.map((staff, i) => (
              <div
                key={staff.name}
                className="flex items-center bg-gray-700 p-3 rounded-lg"
              >
                <span className="text-lg font-bold mr-4">{i + 1}.</span>
                <div className="flex-1">
                  <p className="font-bold text-white">{staff.name}</p>
                  <p className="text-xs text-gray-400">Server</p>
                </div>
                <span className="text-2xl font-bold text-blue-400">
                  {staff.rating} ★
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const KitchenDashboardFinal = ({
  orders,
  currentTime,
  updateStatus,
  menuItems,
  updateStock,
  setMode,
}) => {
  const [view, setView] = useState("manager");
  const [incidents, setIncidents] = useState(INITIAL_INCIDENTS);
  const pending = orders.filter(
    (o) => o.status !== "READY" && o.status !== "SERVED"
  );
  const feedbackOrders = orders.filter((o) => o.feedback);
  const activeServiceRequests = orders.filter(
    (o) => o.serviceRequest && o.status !== "SERVED"
  );

  const allIncidents = useMemo(() => {
    const atRiskOrders = orders
      .filter(
        (o) =>
          o.status === "PREPARING" &&
          !o.manualDelayMinutes &&
          (currentTime - o.timePlaced?.getTime()) / 1000 >
            LATE_ORDER_THRESHOLD_SECONDS
      )
      .map((o) => ({
        id: `late_${o.id}`,
        type: "urgent",
        text: `Order #${o.id.substring(0, 4)} is LATE!`,
        table: o.table,
        time: o.timePlaced.toLocaleTimeString(),
        status: "active",
      }));
    const atRiskService = orders
      .filter(
        (o) =>
          o.serviceRequest &&
          o.serviceRequestTime &&
          (currentTime - o.serviceRequestTime.getTime()) / 1000 >
            LATE_SERVICE_THRESHOLD_SECONDS
      )
      .map((o) => ({
        id: `service_${o.id}`,
        type: "urgent",
        text: `Service Request for ${o.serviceRequest} is LATE!`,
        table: o.table,
        time: o.serviceRequestTime.toLocaleTimeString(),
        status: "active",
      }));
    const manualIncidents = incidents.filter((i) => i.status === "active");
    return [...atRiskOrders, ...atRiskService, ...manualIncidents];
  }, [orders, incidents, currentTime]);

  const activeAlertsCount = allIncidents.length;

  const handleResolveIncident = (id) => {
    if (id.startsWith("late_") || id.startsWith("service_")) {
      alert(
        "This is an automatic alert. It will resolve when the order is advanced or service request is cleared."
      );
    } else {
      setIncidents(
        incidents.map((i) => (i.id === id ? { ...i, status: "resolved" } : i))
      );
    }
  };

  const handleAddDelay = (orderId, currentStatus) => {
    const delayMins = prompt("Enter *additional* delay in minutes (e.g., 10):");
    if (delayMins && !isNaN(delayMins)) {
      updateStatus(orderId, currentStatus, {
        manualDelayMinutes: parseInt(delayMins),
        manualDelayTime: serverTimestamp(),
      });
    }
  };

  return (
    <div className="h-full bg-gray-900 text-white p-6 flex flex-col font-sans relative">
      {activeAlertsCount > 0 && (
        <div className="absolute top-0 left-0 right-0 bg-red-600 text-white p-3 text-center font-bold animate-pulse z-50 flex justify-center space-x-4">
          🚨 {activeAlertsCount} Active Alert(s)!
        </div>
      )}
      <div className="flex justify-between border-b-2 border-gray-800 mb-6 pb-4 mt-8">
        <div className="space-x-4 flex">
          <button
            onClick={() => setView("manager")}
            className={`text-xl font-black px-4 py-2 rounded-xl transition ${
              view === "manager"
                ? "bg-indigo-600 text-white"
                : "text-gray-500 hover:bg-gray-800"
            }`}
          >
            Dashboard
          </button>
          <button
            onClick={() => setView("orders")}
            className={`text-xl font-black px-4 py-2 rounded-xl transition ${
              view === "orders"
                ? "bg-indigo-600 text-white"
                : "text-gray-500 hover:bg-gray-800"
            }`}
          >
            Orders
          </button>
          <button
            onClick={() => setView("stock")}
            className={`text-xl font-black px-4 py-2 rounded-xl transition ${
              view === "stock"
                ? "bg-indigo-600 text-white"
                : "text-gray-500 hover:bg-gray-800"
            }`}
          >
            Stock
          </button>
          <button
            onClick={() => setView("feedback")}
            className={`text-xl font-black px-4 py-2 rounded-xl transition ${
              view === "feedback"
                ? "bg-indigo-600 text-white"
                : "text-gray-500 hover:bg-gray-800"
            }`}
          >
            Feedback
          </button>
          <button
            onClick={() => setView("analytics")}
            className={`text-xl font-black px-4 py-2 rounded-xl transition ${
              view === "analytics"
                ? "bg-indigo-600 text-white"
                : "text-gray-500 hover:bg-gray-800"
            }`}
          >
            Analytics
          </button>
        </div>
        {setMode && (
          <button
            onClick={() => setMode(null)}
            className="text-red-400 font-bold px-3 py-1 rounded-lg border border-red-900/50 hover:bg-red-900/20"
          >
            EXIT
          </button>
        )}
      </div>
      {view === "manager" ? (
        <ManagerDashboard
          orders={orders}
          menuItems={menuItems}
          incidents={allIncidents}
          onResolveIncident={handleResolveIncident}
          currentTime={currentTime}
        />
      ) : view === "stock" ? (
        <KitchenStockView menuItems={menuItems} updateStock={updateStock} />
      ) : view === "analytics" ? (
        <AnalyticsDashboard orders={orders} menuItems={menuItems} />
      ) : view === "feedback" ? (
        <div className="overflow-y-auto flex-1 space-y-4 pr-4">
          <h2 className="font-black text-2xl sticky top-0 bg-gray-900 py-4 z-10">
            Today's Sentiment
          </h2>
          {feedbackOrders.length === 0 ? (
            <p className="text-gray-500">No feedback yet today.</p>
          ) : (
            feedbackOrders.map((order) => {
              const fb = order.feedback;
              const isNegative = fb.foodRating <= 3 || fb.serviceRating <= 3;
              const aiInsight = getSimulatedAIInsight(fb);
              return (
                <div
                  key={order.id}
                  className={`p-5 rounded-3xl border-l-[12px] shadow-lg ${
                    isNegative
                      ? "bg-gray-800 border-orange-500"
                      : "bg-gray-800 border-blue-500"
                  }`}
                >
                  <div className="flex justify-between mb-3">
                    <span className="font-bold">
                      Order #{order.id.substring(0, 4)}
                    </span>
                    <span className="text-gray-400 text-sm">
                      {order.timePlaced.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="bg-gray-900 p-3 rounded-xl">
                      <p className="text-gray-400 text-xs uppercase font-bold">
                        Food ({order.chefName})
                      </p>
                      <StarRating
                        rating={fb.foodRating}
                        readOnly
                        size="w-6 h-6"
                      />
                    </div>
                    <div className="bg-gray-900 p-3 rounded-xl">
                      <p className="text-gray-400 text-xs uppercase font-bold">
                        Service ({order.waiterName})
                      </p>
                      <StarRating
                        rating={fb.serviceRating}
                        readOnly
                        size="w-6 h-6"
                      />
                    </div>
                  </div>
                  {fb.generalComment && (
                    <p className="text-lg italic text-gray-300 mb-4">
                      "{fb.generalComment}"
                    </p>
                  )}
                  {aiInsight && (
                    <div className="bg-indigo-900/50 p-4 rounded-xl border border-indigo-500/30 flex items-start">
                      <span className="text-2xl mr-3">✨</span>
                      <div>
                        <p className="text-indigo-300 font-bold uppercase text-xs tracking-wider mb-1">
                          Gemini Operations Insight
                        </p>
                        <p className="text-indigo-100 font-medium">
                          {aiInsight}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-6 flex-1 overflow-hidden">
          <div className="overflow-y-auto space-y-4 pr-2">
            <h2 className="font-black text-2xl sticky top-0 bg-gray-900 py-4 z-10">
              Preparing ({pending.length})
            </h2>
            {pending.map((o) => (
              <div
                key={o.id}
                className={`bg-white text-gray-900 p-5 rounded-3xl border-l-[12px] shadow-lg ${
                  o.manualDelayMinutes > 0
                    ? "border-red-500"
                    : "border-indigo-500"
                } ${
                  o.serviceRequest && !o.items.length ? "border-yellow-500" : ""
                }`}
              >
                <div className="flex justify-between font-black text-2xl mb-3">
                  <span>
                    #{o.id.substring(0, 4)}{" "}
                    {o.table === "TAKEAWAY"
                      ? "🥡 TAKE AWAY"
                      : `🍽️ TABLE ${o.table}`}
                  </span>
                  {o.manualDelayMinutes > 0 ? (
                    <span className="text-red-600 font-bold animate-pulse">
                      DELAYED +{o.manualDelayMinutes}m
                    </span>
                  ) : (
                    <span
                      className={
                        Math.floor(
                          (currentTime - o.timePlaced?.getTime()) / 1000
                        ) > TEST_WAIT_TIME_SECONDS
                          ? "text-red-600"
                          : "text-gray-400"
                      }
                    >
                      {Math.floor(
                        (currentTime - o.timePlaced?.getTime()) / 1000
                      )}
                      s
                    </span>
                  )}
                </div>
                <div className="flex items-center space-x-2 mb-3">
                  {o.orderType === "TAKEAWAY" && (
                    <span className="bg-indigo-900 text-white text-sm font-black px-3 py-1 rounded-full w-fit tracking-wider">
                      TAKE AWAY
                    </span>
                  )}
                  {o.waiterName && (
                    <span className="bg-gray-200 text-gray-700 text-sm font-bold px-3 py-1 rounded-full w-fit">
                      Waiter: {o.waiterName}
                    </span>
                  )}
                </div>
                {o.serviceRequest && (
                  <div className="bg-red-500 text-white p-3 rounded-xl font-bold mb-3 flex justify-between items-center animate-pulse">
                    <span>
                      🔔 Request: {o.serviceRequest} (
                      {Math.floor(
                        (currentTime - o.serviceRequestTime?.getTime()) / 1000
                      )}
                      s ago)
                    </span>
                    <button
                      onClick={() =>
                        updateStatus(
                          o.id,
                          o.items.length === 0 ? "SERVED" : o.status,
                          { serviceRequest: null }
                        )
                      }
                      className="bg-white text-red-600 px-3 py-1 rounded-full text-xs"
                    >
                      Mark Done
                    </button>
                  </div>
                )}
                <ul className="mb-5 space-y-3">
                  {o.items.map((i, idx) => (
                    <li key={idx} className="border-b-2 border-gray-100 pb-3">
                      <span className="font-black text-xl">{i.name}</span>
                      <p className="text-base font-medium text-gray-500 mt-1">
                        {Object.values(i.modifiers || {})
                          .flat()
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                      {i.specialRequest && (
                        <p className="text-base font-bold text-yellow-600 mt-1 bg-yellow-50 p-2 rounded-lg">
                          ⚠️ Note: {i.specialRequest}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="flex space-x-2 mt-4">
                  {o.items.length > 0 && (
                    <button
                      onClick={() =>
                        updateStatus(o.id, STATUS_FLOW[o.status].next)
                      }
                      className={`flex-1 py-3 font-black rounded-2xl text-xl text-white shadow-md ${
                        STATUS_FLOW[o.status].color
                      }`}
                    >
                      {STATUS_FLOW[o.status].next}
                    </button>
                  )}
                  {o.status === "PREPARING" && (
                    <button
                      onClick={() => handleAddDelay(o.id, o.status)}
                      className="w-1/3 py-3 bg-red-600 text-white font-black rounded-2xl text-xl shadow-md"
                    >
                      DELAY
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="overflow-y-auto pl-4 border-l-2 border-gray-800">
            <h2 className="font-black text-2xl sticky top-0 bg-gray-900 py-4 z-10 text-green-500">
              Ready for Pickup
            </h2>
            {orders
              .filter((o) => o.status === "READY")
              .map((o) => (
                <div
                  key={o.id}
                  className="bg-green-500 text-white p-6 rounded-[30px] font-black text-3xl mb-4 shadow-lg flex items-center justify-between"
                >
                  <span>
                    #{o.id.substring(0, 4)}{" "}
                    {o.table === "TAKEAWAY" ? "🥡" : `T-${o.table}`}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};

// --- MAIN APP ---
export default function App() {
  const [mode, setMode] = useState(null);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const { db, auth } = useMemo(() => {
    const app = initializeApp(firebaseConfig);
    return { db: getFirestore(app), auth: getAuth(app) };
  }, []);
  const {
    orders,
    userId,
    isAuthReady,
    updateStockQuantity,
    decreaseStockFromCart,
    getOrderPath,
  } = useFirestore(db, auth);
  const { menuItems, loadingMenu } = useMenu(db);

  useEffect(() => {
    const t = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (db && appId && !loadingMenu && !localStorage.getItem("seeded_v41")) {
      seedDatabase(db, appId);
      localStorage.setItem("seeded_v41", "true");
    }
  }, [db, loadingMenu]);

  const handleKitchenStatusUpdate = async (id, status, extraFields = {}) => {
    await updateDoc(getOrderPath(id), {
      status,
      ...extraFields,
      ...(status === "READY" ? { timeReady: serverTimestamp() } : {}),
    });
  };

  if (!isAuthReady || loadingMenu) return <LoadingScreen />;
  if (!mode)
    return (
      <div className="flex flex-col h-screen items-center justify-center bg-gray-900 space-y-10 font-sans p-6">
        <div className="text-center">
          <h1 className="text-white text-6xl font-black tracking-tighter mb-4">
            SmartServe
          </h1>
          <p className="text-indigo-400 text-xl font-medium">
            Restaurant OS Demo
          </p>
        </div>
        <div className="flex space-x-8">
          <button
            onClick={() => setMode("customer")}
            className="group relative px-12 py-10 bg-white rounded-[40px] shadow-2xl hover:scale-105 transition-all duration-300"
          >
            <div className="text-5xl mb-4 group-hover:-translate-y-2 transition-transform">
              📱
            </div>
            <span className="text-3xl font-black text-gray-900">
              Customer App
            </span>
          </button>
          <button
            onClick={() => setMode("kitchen")}
            className="group relative px-12 py-10 bg-indigo-600 rounded-[40px] shadow-2xl hover:scale-105 transition-all duration-300"
          >
            <div className="text-5xl mb-4 group-hover:-translate-y-2 transition-transform">
              👨‍🍳
            </div>
            <span className="text-3xl font-black text-white">
              Restaurant Hub
            </span>
          </button>
        </div>
        <button
          onClick={() => setMode("split")}
          className="px-8 py-4 bg-gray-800 text-gray-300 rounded-2xl font-bold text-lg border-2 border-gray-700 hover:bg-gray-700 transition"
        >
          🛠️ Split View Mode
        </button>
      </div>
    );

  if (mode === "split")
    return (
      <div className="flex w-full h-screen overflow-hidden bg-gray-900">
        <div className="w-1/2 h-full border-r-4 border-gray-800">
          <CustomerAppContainerFixed
            db={db}
            userId={userId}
            menuItems={menuItems}
            orders={orders}
            currentTime={currentTime}
            decreaseStockFromCart={decreaseStockFromCart}
            getOrderPath={getOrderPath}
            setMode={setMode}
            isSplit={true}
          />
        </div>
        <div className="w-1/2 h-full">
          <KitchenDashboardFinal
            orders={orders}
            currentTime={currentTime}
            menuItems={menuItems}
            updateStock={updateStockQuantity}
            updateStatus={handleKitchenStatusUpdate}
            setMode={null}
          />
        </div>
      </div>
    );

  return mode === "kitchen" ? (
    <KitchenDashboardFinal
      orders={orders}
      currentTime={currentTime}
      menuItems={menuItems}
      updateStock={updateStockQuantity}
      updateStatus={handleKitchenStatusUpdate}
      setMode={setMode}
    />
  ) : (
    <CustomerAppContainerFixed
      db={db}
      userId={userId}
      menuItems={menuItems}
      orders={orders}
      currentTime={currentTime}
      decreaseStockFromCart={decreaseStockFromCart}
      getOrderPath={getOrderPath}
      setMode={setMode}
    />
  );
}
