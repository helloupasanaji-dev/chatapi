# Simple Express API

## Run it

1. Install [Node.js](https://nodejs.org/) if it is not already installed.
2. In this folder, run `npm install` once.
3. Make sure `atlas-credentials.env` has a valid `MONGODB_URI` for your MongoDB Atlas cluster. `MONGODB_SEEDS` and `MONGODB_REPLICA_SET` let the app connect through explicit cluster hosts where Node's SRV DNS lookup is unavailable. The app reads `MONGODB_DATABASE` if provided; otherwise it uses `chat_api`.
4. Start the API with `npm start`. The server connects to MongoDB before it starts accepting requests.
5. Open <http://localhost:3000> to register or sign in. Open the chat in two signed-in browser tabs to try messaging and calls.

## Try the routes

- `GET http://localhost:3000/` — opens the chat when signed in, or redirects to the login page.
- `GET http://localhost:3000/login` — displays the sign-in and account registration page.
- `POST http://localhost:3000/api/auth/register` — registers `{ "name": "Asha Kumar", "email": "asha@example.com", "password": "use-a-long-password" }`.
- `POST http://localhost:3000/api/auth/login` — signs in using email and password.
- `GET http://localhost:3000/api/auth/me` — returns the signed-in account.
- `POST http://localhost:3000/api/auth/logout` — signs out and clears the session cookie.
- `GET http://localhost:3000/api/messages` — returns the latest 100 chat messages.
- `POST http://localhost:3000/api/messages` — sends `{ "username": "Asha", "text": "Hi!" }`.
- `GET http://localhost:3000/api/chat-names` — lists names saved from messages and online chat sessions.
- Use **🎙 Voice** in the chat to record and send a voice message (up to 60 seconds). Voice messages appear with an audio player.
- Use **🎤 Dictate** to put live speech recognition into the message box while you speak, then send the text as a regular chat message. Dictation support depends on the browser.
- Use **Call friend** for a direct audio call, or select an online friend and choose **Audio call** or **Video call**. The other person must accept and allow microphone/camera access.
- `GET http://localhost:3000/things` — returns the example list.
- `POST http://localhost:3000/things` — adds an item. Send JSON such as `{"name":"Practice"}` with `Content-Type: application/json`.
- `GET http://localhost:3000/news` — returns sample news articles.
- `GET http://localhost:3000/news/1` — returns one article by ID.
- `GET http://localhost:3000/news?category=Community` — filters by category.
- `GET http://localhost:3000/news?search=garden` — searches article titles, summaries, categories, and authors.
- `GET http://localhost:3000/restaurants` — lists sample restaurants (menu omitted).
- `GET http://localhost:3000/restaurants?cuisine=Italian` — filters restaurants by cuisine.
- `GET http://localhost:3000/restaurants/1` — shows restaurant details and its menu.
- `GET http://localhost:3000/restaurants/1/menu` — shows only that restaurant's menu.
- `POST http://localhost:3000/orders` — creates a sample food delivery order. Send JSON such as:

```json
{
  "restaurantId": 1,
  "items": [{ "itemId": 101, "quantity": 2 }, { "itemId": 103, "quantity": 1 }],
  "customer": {
    "name": "Asha Kumar",
    "phone": "9876543210",
    "address": "12 Lake Road, Bengaluru"
  }
}
```

- `GET http://localhost:3000/orders/1` — checks an order and its current status.
- `POST http://localhost:3000/auth/google` — creates a demo profile from `{ "googleId": "demo-123", "name": "Asha Kumar", "email": "asha@example.com" }`. This does not verify Google identity.
- `GET http://localhost:3000/delivery/estimate?restaurantId=1&latitude=12.97&longitude=77.59` — returns a demo distance and delivery estimate for coordinates.
- `POST http://localhost:3000/payments/upi` — creates a pending demo payment record from `{ "orderId": 1, "upiId": "asha@bank" }`. It does not charge money.

## What the main words mean

- **API**: a way for programs to ask your server for information or send it information.
- **Route**: a URL your server responds to, such as `/things`.
- **GET**: ask the server for information.
- **POST**: send information to the server.
- **Request (`req`)**: what the caller sends to your server.
- **Response (`res`)**: what your server sends back.

User accounts, chat messages, chat names, voice notes, sample restaurants, news, demo profiles, payments, orders, and things are stored in MongoDB. Passwords are stored as bcrypt hashes; signed-in sessions use an HttpOnly cookie. Chat and signaling require a signed-in account. The sample news, restaurants, and things are inserted the first time their collections are empty. Voice notes are limited to 5 MB. The chat refreshes every few seconds. Audio/video calls use WebRTC with a WebSocket signaling channel; try them between two signed-in browser tabs on localhost. Calls and voice recording need microphone permission. Video calls also need camera permission and a network that allows peer-to-peer WebRTC. A production deployment needs HTTPS and a TURN relay for networks where direct peer connections are blocked. The Google sign-up, UPI payment, and delivery coordinates are also demo flows only: production use needs verified Google OAuth ID tokens, a payment provider integration, and real restaurant geolocation.

Keep `atlas-credentials.env` private. It is excluded by `.gitignore`; never commit or share its database credentials.
