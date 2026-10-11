const express = require('express');
const path = require('path');
const http = require('http');
const { randomUUID } = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

require('dotenv').config({ path: path.join(__dirname, 'atlas-credentials.env') });

const app = express();
const PORT = 3000;
const server = http.createServer(app);
const signaling = new WebSocketServer({ server, path: '/signal' });
const callPeers = new Map();
let database;

function makeMongoClient() {
  const sourceUri = process.env.MONGODB_URI;
  if (!sourceUri) return null;

  if (sourceUri.startsWith('mongodb+srv://') && process.env.MONGODB_SEEDS) {
    const source = new URL(sourceUri);
    const options = new URLSearchParams(source.search);
    if (process.env.MONGODB_REPLICA_SET) options.set('replicaSet', process.env.MONGODB_REPLICA_SET);
    if (!options.has('tls')) options.set('tls', 'true');
    if (!options.has('authSource')) options.set('authSource', 'admin');
    return new MongoClient(`mongodb://${source.username}:${source.password}@${process.env.MONGODB_SEEDS}${source.pathname}?${options}`);
  }

  return new MongoClient(sourceUri);
}

const mongoClient = makeMongoClient();

async function saveChatName(name) {
  if (!database || !name) return;
  await database.collection('chatNames').updateOne(
    { name },
    { $set: { lastSeenAt: new Date().toISOString() } },
    { upsert: true }
  );
}

async function loadCollection(name, cache, seed = []) {
  const collection = database.collection(name);
  const records = await collection.find({}, { projection: { _id: 0 } }).sort({ id: 1 }).toArray();
  if (records.length) {
    cache.splice(0, cache.length, ...records);
  } else if (seed.length) {
    await collection.insertMany(seed);
    cache.splice(0, cache.length, ...seed);
  }
}

// This lets Express read JSON sent in a request body.
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function readSession(req) {
  try {
    const token = req.cookies?.chat_session;
    if (!token || !process.env.JWT_SECRET) return null;
    const claims = jwt.verify(token, process.env.JWT_SECRET);
    return { id: claims.sub, name: claims.name, email: claims.email };
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'Please sign in to continue.' });
  req.auth = user;
  next();
}

function setSessionCookie(req, res, user) {
  const token = jwt.sign({ name: user.name, email: user.email }, process.env.JWT_SECRET, {
    subject: String(user.id),
    expiresIn: '7d'
  });
  res.cookie('chat_session', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', (req, res) => {
  if (!readSession(req)) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/auth/register', async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (name.length < 2 || name.length > 40) {
    return res.status(400).json({ error: 'Name must be between 2 and 40 characters.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).json({ error: 'Password must be at least 8 characters and no more than 72 bytes.' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const user = { name, email, passwordHash, createdAt: new Date().toISOString() };
    const result = await database.collection('users').insertOne(user);
    const publicUser = { id: result.insertedId.toString(), name, email };
    setSessionCookie(req, res, publicUser);
    await saveChatName(name).catch(() => {});
    return res.status(201).json({ user: publicUser });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'An account with that email already exists. Sign in instead.' });
    return res.status(503).json({ error: 'Could not create your account. Please try again.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  try {
    const user = await database.collection('users').findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    const publicUser = { id: user._id.toString(), name: user.name, email: user.email };
    setSessionCookie(req, res, publicUser);
    await saveChatName(user.name).catch(() => {});
    return res.json({ user: publicUser });
  } catch {
    return res.status(503).json({ error: 'Could not sign in right now. Please try again.' });
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.auth }));
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('chat_session', { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
  res.json({ success: true });
});

// WebRTC signaling only: audio and video flow directly between browsers.
signaling.on('connection', (socket, request) => {
  const cookies = String(request.headers.cookie || '').split(';').map((part) => part.trim());
  const token = cookies.find((part) => part.startsWith('chat_session='))?.slice('chat_session='.length);
  let session;
  try {
    if (token) session = jwt.verify(token, process.env.JWT_SECRET);
  } catch {}
  if (!session?.sub) {
    socket.close(1008, 'Please sign in first.');
    return;
  }
  socket.peerId = randomUUID();
  socket.username = session.name;
  const peers = Array.from(callPeers.keys());
  callPeers.set(socket.peerId, socket);
  socket.send(JSON.stringify({ type: 'ready', peerId: socket.peerId, peers }));
  for (const peer of callPeers.values()) {
    if (peer !== socket && peer.readyState === WebSocket.OPEN) {
      peer.send(JSON.stringify({ type: 'peer-joined', peerId: socket.peerId }));
    }
  }
  const broadcastUsers = () => {
    const message = JSON.stringify({
      type: 'online-users',
      users: Array.from(callPeers.entries()).map(([peerId, peerSocket]) => ({ peerId, name: peerSocket.username }))
    });
    for (const peer of callPeers.values()) {
      if (peer.readyState === WebSocket.OPEN) peer.send(message);
    }
  };
  socket.broadcastUsers = broadcastUsers;
  broadcastUsers();

  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'presence') {
      saveChatName(socket.username).catch(() => {});
      broadcastUsers();
      return;
    }
    if (!message.to || !message.payload || typeof message.type !== 'string') return;
    const target = callPeers.get(message.to);
    if (target && target.readyState === WebSocket.OPEN) {
      target.send(JSON.stringify({ type: 'signal', from: socket.peerId, signalType: message.type, payload: message.payload }));
    }
  });

  socket.on('close', () => {
    callPeers.delete(socket.peerId);
    for (const peer of callPeers.values()) {
      if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: 'peer-left', peerId: socket.peerId }));
    }
    broadcastUsers();
  });
});

// A small example list stored in memory.
const things = [
  { id: 1, name: 'Learn Express' },
  { id: 2, name: 'Build an API' }
];

// Sample news stories served by the API. These are in-memory demo records.
const news = [
  {
    id: 1,
    title: 'Community garden opens downtown',
    summary: 'Neighbors celebrated the opening of a new shared garden with space to grow vegetables and flowers.',
    category: 'Community',
    author: 'Maya Patel',
    publishedAt: '2026-10-09T09:00:00Z',
    imageUrl: 'https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=1200&auto=format&fit=crop&q=80'
  },
  {
    id: 2,
    title: 'City library extends weekend hours',
    summary: 'The central library will stay open later on Saturdays to give students and families more time to visit.',
    category: 'Education',
    author: 'Jordan Lee',
    publishedAt: '2026-10-08T14:30:00Z',
    imageUrl: 'https://images.unsplash.com/photo-1507842217343-583bb7270b66?w=1200&auto=format&fit=crop&q=80'
  },
  {
    id: 3,
    title: 'Local team wins regional final',
    summary: 'A late goal secured the championship after a close match in front of a cheering home crowd.',
    category: 'Sports',
    author: 'Alex Morgan',
    publishedAt: '2026-10-07T18:15:00Z',
    imageUrl: 'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?w=1200&auto=format&fit=crop&q=80'
  }
];

// Demo restaurant catalog with menus, stored in memory.
const restaurants = [
  {
    id: 1,
    name: 'Spice Garden',
    cuisine: ['Indian', 'North Indian'],
    rating: 4.5,
    deliveryTime: '25-35 min',
    deliveryFee: 30,
    menu: [
      { id: 101, name: 'Paneer Butter Masala', description: 'Paneer in a creamy tomato gravy', price: 260, isVeg: true },
      { id: 102, name: 'Chicken Biryani', description: 'Fragrant basmati rice with spiced chicken', price: 320, isVeg: false },
      { id: 103, name: 'Garlic Naan', description: 'Soft naan topped with garlic', price: 55, isVeg: true }
    ]
  },
  {
    id: 2,
    name: 'Pasta Street',
    cuisine: ['Italian', 'Fast Food'],
    rating: 4.2,
    deliveryTime: '20-30 min',
    deliveryFee: 25,
    menu: [
      { id: 201, name: 'Penne Alfredo', description: 'Penne pasta in creamy white sauce', price: 280, isVeg: true },
      { id: 202, name: 'Margherita Pizza', description: 'Classic pizza with tomato and mozzarella', price: 300, isVeg: true }
    ]
  },
  {
    id: 3,
    name: 'Burger Hub',
    cuisine: ['American', 'Fast Food'],
    rating: 4.0,
    deliveryTime: '30-40 min',
    deliveryFee: 20,
    menu: [
      { id: 301, name: 'Classic Veg Burger', description: 'Crispy veggie patty with lettuce and sauce', price: 150, isVeg: true },
      { id: 302, name: 'Grilled Chicken Burger', description: 'Grilled chicken with fresh lettuce', price: 220, isVeg: false }
    ]
  }
];

const orders = [];
const demoUsers = [];
const payments = [];
const chatMessages = [];
const voiceMessages = [];

function isValidCoordinates(location) {
  return location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude)) &&
    Number(location.latitude) >= -90 && Number(location.latitude) <= 90 &&
    Number(location.longitude) >= -180 && Number(location.longitude) <= 180;
}

// GET /things returns all the things as JSON.
app.get('/things', (req, res) => {
  res.json(things);
});

// Basic in-memory chat API used by the browser chat at /.
app.get('/api/messages', requireAuth, (req, res) => {
  res.json(chatMessages.slice(-100));
});

app.post('/api/messages', requireAuth, async (req, res) => {
  const username = req.auth.name;
  const text = typeof req.body.text === 'string' ? req.body.text.trim().slice(0, 500) : '';
  if (!username || !text) {
    return res.status(400).json({ error: 'Please provide a name and a message.' });
  }

  const message = { id: chatMessages.length + 1, username, text, sentAt: new Date().toISOString() };
  try {
    await saveChatName(username);
    await database.collection('chatMessages').insertOne(message);
  } catch {
    return res.status(503).json({ error: 'Could not save the message to the database.' });
  }
  chatMessages.push(message);
  res.status(201).json(message);
});

app.get('/api/chat-names', requireAuth, async (req, res) => {
  try {
    const names = await database.collection('chatNames').find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray();
    res.json(names);
  } catch {
    res.status(503).json({ error: 'Could not load chat names from the database.' });
  }
});

app.get('/api/voice-messages', requireAuth, (req, res) => {
  res.json(voiceMessages.slice(-50));
});

app.post('/api/voice-messages', requireAuth, express.raw({ type: 'audio/*', limit: '5mb' }), async (req, res) => {
  const username = req.auth.name;
  const contentType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  const supportedTypes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/wav', 'audio/mpeg'];
  if (!username || !Buffer.isBuffer(req.body) || req.body.length === 0 || !supportedTypes.includes(contentType)) {
    return res.status(400).json({ error: 'Send a recorded audio clip with a name.' });
  }

  const voiceMessage = {
    id: voiceMessages.length + 1,
    username,
    mimeType: contentType,
    audioBase64: req.body.toString('base64'),
    sentAt: new Date().toISOString()
  };
  try {
    await saveChatName(username);
    await database.collection('voiceMessages').insertOne(voiceMessage);
  } catch {
    return res.status(503).json({ error: 'Could not save the voice message to the database.' });
  }
  voiceMessages.push(voiceMessage);
  res.status(201).json({ id: voiceMessage.id, username, mimeType: contentType, sentAt: voiceMessage.sentAt });
});

// DEMO ONLY: this accepts a profile, it does not verify a Google credential.
// Use Google's OAuth flow and verify ID tokens on the server for real sign-in.
app.post('/auth/google', async (req, res) => {
  const { email, name, googleId } = req.body;
  if (!email || !name || !googleId) {
    return res.status(400).json({ error: 'Include email, name, and googleId for this demo sign-up.' });
  }

  let user = demoUsers.find((item) => item.googleId === String(googleId));
  if (!user) {
    user = { id: demoUsers.length + 1, googleId: String(googleId), email: String(email), name: String(name) };
    try {
      await database.collection('demoUsers').insertOne(user);
    } catch {
      return res.status(503).json({ error: 'Could not save the profile to the database.' });
    }
    demoUsers.push(user);
  }
  res.status(200).json({ demo: true, message: 'Demo profile created. Google identity was not verified.', user });
});

// Estimate delivery distance using the customer's device coordinates.
app.get('/delivery/estimate', (req, res) => {
  const restaurant = restaurants.find((item) => item.id === Number(req.query.restaurantId));
  const location = { latitude: req.query.latitude, longitude: req.query.longitude };
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  if (!isValidCoordinates(location)) {
    return res.status(400).json({ error: 'Provide valid latitude and longitude coordinates.' });
  }
  // Demo restaurant location; replace with geocoded restaurant coordinates in a real service.
  const restaurantLocation = { latitude: 12.9716 + restaurant.id * 0.01, longitude: 77.5946 + restaurant.id * 0.01 };
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const dLat = toRadians(Number(location.latitude) - restaurantLocation.latitude);
  const dLng = toRadians(Number(location.longitude) - restaurantLocation.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(restaurantLocation.latitude)) *
    Math.cos(toRadians(Number(location.latitude))) * Math.sin(dLng / 2) ** 2;
  const distanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  res.json({ restaurantId: restaurant.id, distanceKm: Number(distanceKm.toFixed(2)), deliveryFee: restaurant.deliveryFee, estimatedTime: restaurant.deliveryTime, demo: true });
});

// GET /news?category=Community&search=garden returns matching stories.
app.get('/news', (req, res) => {
  const { category, search } = req.query;
  let results = news;

  if (category) {
    results = results.filter((article) => article.category.toLowerCase() === String(category).toLowerCase());
  }

  if (search) {
    const term = String(search).toLowerCase();
    results = results.filter((article) =>
      `${article.title} ${article.summary} ${article.category} ${article.author}`.toLowerCase().includes(term)
    );
  }

  res.json({ count: results.length, articles: results });
});

// GET /news/1 returns one story, or a 404 when it does not exist.
app.get('/news/:id', (req, res) => {
  const article = news.find((item) => item.id === Number(req.params.id));
  if (!article) {
    return res.status(404).json({ error: 'News article not found.' });
  }
  res.json(article);
});

// GET /restaurants?search=pasta&cuisine=Italian returns matching restaurants.
app.get('/restaurants', (req, res) => {
  const { search, cuisine } = req.query;
  let results = restaurants;

  if (search) {
    const term = String(search).toLowerCase();
    results = results.filter((restaurant) => restaurant.name.toLowerCase().includes(term));
  }
  if (cuisine) {
    const term = String(cuisine).toLowerCase();
    results = results.filter((restaurant) => restaurant.cuisine.some((item) => item.toLowerCase() === term));
  }

  res.json({ count: results.length, restaurants: results.map(({ menu, ...restaurant }) => restaurant) });
});

// GET /restaurants/1 and /restaurants/1/menu return restaurant details and menu.
app.get('/restaurants/:id', (req, res) => {
  const restaurant = restaurants.find((item) => item.id === Number(req.params.id));
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  res.json(restaurant);
});

app.get('/restaurants/:id/menu', (req, res) => {
  const restaurant = restaurants.find((item) => item.id === Number(req.params.id));
  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  res.json({ restaurantId: restaurant.id, restaurantName: restaurant.name, menu: restaurant.menu });
});

// POST /orders accepts { restaurantId, items: [{ itemId, quantity }], customer: { name, phone, address } }.
app.post('/orders', async (req, res) => {
  const { restaurantId, items, customer, deliveryLocation } = req.body;
  const restaurant = restaurants.find((item) => item.id === Number(restaurantId));

  if (!restaurant) return res.status(404).json({ error: 'Restaurant not found.' });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Please include at least one menu item.' });
  }
  if (!customer || !customer.name || !customer.phone || !customer.address) {
    return res.status(400).json({ error: 'Please include customer name, phone, and address.' });
  }
  if (deliveryLocation && !isValidCoordinates(deliveryLocation)) {
    return res.status(400).json({ error: 'deliveryLocation must include valid latitude and longitude.' });
  }

  const orderItems = [];
  for (const requestedItem of items) {
    const menuItem = restaurant.menu.find((item) => item.id === Number(requestedItem.itemId));
    const quantity = Number(requestedItem.quantity);
    if (!menuItem || !Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'Each item must have a valid itemId and a positive whole-number quantity.' });
    }
    orderItems.push({ ...menuItem, quantity, total: menuItem.price * quantity });
  }

  const subtotal = orderItems.reduce((sum, item) => sum + item.total, 0);
  const order = {
    id: orders.length + 1,
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    customer,
    deliveryLocation: deliveryLocation || null,
    items: orderItems,
    subtotal,
    deliveryFee: restaurant.deliveryFee,
    total: subtotal + restaurant.deliveryFee,
    status: 'Order received',
    paymentStatus: 'unpaid',
    createdAt: new Date().toISOString()
  };
  try {
    await database.collection('orders').insertOne(order);
  } catch {
    return res.status(503).json({ error: 'Could not save the order to the database.' });
  }
  orders.push(order);
  res.status(201).json(order);
});

// DEMO ONLY: creates a pending UPI payment record; it does not charge money.
app.post('/payments/upi', async (req, res) => {
  const { orderId, upiId } = req.body;
  const order = orders.find((item) => item.id === Number(orderId));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (typeof upiId !== 'string' || !/^[\w.-]{2,256}@[\w.-]{2,64}$/.test(upiId)) {
    return res.status(400).json({ error: 'Provide a valid UPI ID, such as name@bank.' });
  }
  const payment = {
    id: payments.length + 1,
    orderId: order.id,
    amount: order.total,
    method: 'UPI',
    upiId,
    status: 'pending',
    demo: true,
    createdAt: new Date().toISOString()
  };
  try {
    await database.collection('payments').insertOne(payment);
  } catch {
    return res.status(503).json({ error: 'Could not save the payment to the database.' });
  }
  payments.push(payment);
  res.status(201).json({ ...payment, message: 'Demo payment created only. No money was charged.' });
});

// GET /orders/1 returns the current status and details for an order.
app.get('/orders/:id', (req, res) => {
  const order = orders.find((item) => item.id === Number(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json(order);
});

// POST /things adds a thing. Send JSON like: { "name": "Practice" }
app.post('/things', async (req, res) => {
  const name = req.body.name;

  if (!name) {
    return res.status(400).json({ error: 'Please include a name.' });
  }

  const newThing = {
    id: things.length + 1,
    name: name
  };

  try {
    await database.collection('things').insertOne(newThing);
  } catch {
    return res.status(503).json({ error: 'Could not save the item to the database.' });
  }
  things.push(newThing);
  res.status(201).json(newThing);
});

// Start the server so it can receive requests.
async function startServer() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing from atlas-credentials.env');
  }
  await mongoClient.connect();
  database = mongoClient.db(process.env.MONGODB_DATABASE || 'chat_api');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is missing from atlas-credentials.env');
  await database.collection('users').createIndex({ email: 1 }, { unique: true });

  await Promise.all([
    loadCollection('things', things, things.slice()),
    loadCollection('news', news, news.slice()),
    loadCollection('restaurants', restaurants, restaurants.slice()),
    loadCollection('chatMessages', chatMessages),
    loadCollection('voiceMessages', voiceMessages),
    loadCollection('demoUsers', demoUsers),
    loadCollection('orders', orders),
    loadCollection('payments', payments)
  ]);

  server.listen(PORT, () => {
    console.log(`API is running at http://localhost:${PORT} (MongoDB connected)`);
  });
}

startServer().catch(() => {
  console.error('Could not connect to MongoDB. Check atlas-credentials.env and Atlas network access.');
  process.exit(1);
});
