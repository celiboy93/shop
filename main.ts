// Deno KV Database Setup
const kv = await Deno.openKv(); 

// --- Configuration and Security ---
// 🚨 ADMIN_TOKEN SETUP: For security, set this in Deno Deploy Environment Variables.
// Key: ADMIN_TOKEN, Value: YourSecretPassword (e.g., "mysecrettoken123")
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") || "hardcoded_admin_pass"; 
const SESSION_COOKIE_NAME = "session_id";

// --- User Data Structure ---
interface User {
    username: string;
    passwordHash: string;
    balance: number; // User's credit/money in Ks
}

// ----------------------------------------------------
// Core KV Functions (Data Management)
// ----------------------------------------------------

async function getUserByUsername(username: string): Promise<User | null> {
    const key = ["users", username];
    const result = await kv.get<User>(key);
    return result.value;
}

async function registerUser(username: string, passwordHash: string): Promise<boolean> {
    const user: User = { username, passwordHash, balance: 0 };
    const key = ["users", username];

    const res = await kv.atomic()
        .check({ key, versionstamp: null }) // Check if user exists
        .set(key, user)
        .commit();

    return res.ok;
}

/**
 * Handles all transactions (Top-Up or Buying) securely using KV atomic operation.
 */
async function updateUserBalance(username: string, amountChange: number): Promise<boolean> {
    const key = ["users", username];
    
    // KV Atomic Transaction: Ensures the read and write happen together
    while (true) {
        const result = await kv.get<User>(key);
        const user = result.value;
        
        if (!user) return false; 

        const newBalance = user.balance + amountChange;
        
        // Safety check: Cannot go into negative balance (only applies to buying)
        if (newBalance < 0) return false; 

        const res = await kv.atomic()
            .check(result) // Ensure we are updating the version we just read
            .set(key, { ...user, balance: newBalance })
            .commit();
        
        if (res.ok) {
            return true; // Success!
        }
        // If not ok, loop and retry the transaction
    }
}

// ----------------------------------------------------
// Authentication Helpers
// ----------------------------------------------------

function verifyPassword(inputPassword: string, storedHash: string): boolean {
    // SECURITY WARNING: In a real app, use bcrypt or Argon2!
    return inputPassword === storedHash;
}

function getUsernameFromCookie(req: Request): string | null {
    const cookieHeader = req.headers.get("Cookie");
    if (!cookieHeader || !cookieHeader.includes(SESSION_COOKIE_NAME)) {
        return null;
    }
    try {
        // Simple cookie parsing
        const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
        return match ? match[1].split(';')[0] : null;
    } catch {
        return null;
    }
}

// ----------------------------------------------------
// Route Handlers
// ----------------------------------------------------

// ROUTE: /admin/topup (Admin adds money to user account)
async function handleAdminTopUp(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // 1. Authorization Check (Token must match the one set in Deno Deploy Environment Variables)
    const token = url.searchParams.get("token");
    if (token !== ADMIN_TOKEN || ADMIN_TOKEN === "hardcoded_admin_pass") {
        return new Response("Unauthorized or ADMIN_TOKEN not set.", { status: 403 });
    }

    // 2. Get Transaction Details
    const username = url.searchParams.get("name");
    const amountStr = url.searchParams.get("amount");
    const amount = amountStr ? parseInt(amountStr) : NaN;

    if (!username || isNaN(amount) || amount <= 0) {
        return new Response("Missing 'name' or invalid 'amount'. Usage: /admin/topup?token=...&name=...&amount=...", { status: 400 });
    }

    // 3. Process Transaction (Adding the amount)
    const success = await updateUserBalance(username, amount);

    if (success) {
        const updatedUser = await getUserByUsername(username);
        return new Response(`${username} balance updated. New balance: ${updatedUser?.balance} Ks`, { status: 200 });
    } else {
        return new Response(`Failed to update balance for ${username}. User may not exist.`, { status: 500 });
    }
}

// ROUTE: /login (Display login form)
function renderLoginForm(): Response {
    const html = `
        <!DOCTYPE html>
        <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Login</title>
        <style>body{font-family:sans-serif;} button{padding:10px 20px;}</style>
        </head>
        <body>
            <h1>User Login</h1>
            <form action="/auth" method="POST">
                <label for="username">Name:</label><br>
                <input type="text" id="username" name="username" required><br><br>
                <label for="password">Password:</label><br>
                <input type="password" id="password" name="password" required><br><br>
                <button type="submit">Log In</button>
            </form>
            <p style="margin-top:20px;">Test User: ko_aung / password123</p>
        </body>
        </html>
    `;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ROUTE: /auth (Process login form submission)
async function handleAuth(req: Request): Promise<Response> {
    const formData = await req.formData();
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();

    if (!username || !password) {
        return new Response("Missing username or password.", { status: 400 });
    }

    const user = await getUserByUsername(username);

    if (!user || !verifyPassword(password, user.passwordHash)) {
        return new Response("Invalid username or password.", { status: 401 });
    }

    // SUCCESS: Set a session cookie and redirect
    const sessionId = username; 
    const headers = new Headers();
    headers.set("Location", "/dashboard");
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; Max-Age=3600; HttpOnly`); // 1 hour session

    return new Response("Login successful. Redirecting...", { status: 302, headers });
}

// ROUTE: /buy (Process purchase transaction)
async function handleBuy(req: Request, username: string): Promise<Response> {
    const formData = await req.formData();
    const item = formData.get("item")?.toString();
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;

    if (!item || isNaN(price) || price <= 0) {
        return new Response("Invalid item or price.", { status: 400 });
    }

    // Attempt the transaction (deduct the price, hence negative amount)
    const success = await updateUserBalance(username, -price); 

    if (success) {
        return new Response(`Successfully bought ${item} for ${price} Ks. <a href="/dashboard">Back to Dashboard</a>`, { status: 200, headers: { "Content-Type": "text/html" } });
    } else {
        return new Response(`Transaction failed. Check balance or user existence. <a href="/dashboard">Back to Dashboard</a>`, { status: 400, headers: { "Content-Type": "text/html" } });
    }
}

// ROUTE: /dashboard (Show user info and shop items)
async function handleDashboard(username: string): Promise<Response> {
    const user = await getUserByUsername(username);
    if (!user) {
        return handleLogout(); // Should not happen
    }
    
    // Define items and prices
    const coffeePrice = 2000;
    const teaPrice = 1500;
    
    const html = `
        <!DOCTYPE html>
        <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Dashboard</title>
        <style>body{font-family:sans-serif; margin:20px;} button{padding:10px 20px; border:1px solid #ccc;} .item-card{border:1px solid #eee; padding:15px; margin-bottom:15px;} .disabled{opacity:0.6; cursor:not-allowed;}</style>
        </head>
        <body>
            <h1>Welcome, ${user.username}!</h1>
            <p style="font-size: 1.5em; color: #007bff;">Balance: <strong>${user.balance} Ks</strong></p>
            <hr>
            <h2>Shop:</h2>
            
            <div class="item-card">
                <h3>☕ Coffee (${coffeePrice} Ks)</h3>
                <form action="/buy" method="POST">
                    <input type="hidden" name="item" value="Coffee">
                    <input type="hidden" name="price" value="${coffeePrice}">
                    <button type="submit" ${user.balance < coffeePrice ? 'disabled class="disabled"' : ''}>Buy Coffee</button>
                    ${user.balance < coffeePrice ? '<span style="color:red; margin-left:10px;"> (Insufficient Balance)</span>' : ''}
                </form>
            </div>
            
            <div class="item-card">
                <h3>🍵 Tea (${teaPrice} Ks)</h3>
                <form action="/buy" method="POST">
                    <input type="hidden" name="item" value="Tea">
                    <input type="hidden" name="price" value="${teaPrice}">
                    <button type="submit" ${user.balance < teaPrice ? 'disabled class="disabled"' : ''}>Buy Tea</button>
                    ${user.balance < teaPrice ? '<span style="color:red; margin-left:10px;"> (Insufficient Balance)</span>' : ''}
                </form>
            </div>
            
            <p style="margin-top: 30px;"><a href="/logout">Logout</a></p>
        </body>
        </html>
    `;

    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ROUTE: /logout
function handleLogout(): Response {
    const headers = new Headers();
    headers.set("Location", "/login");
    // Clear the session cookie
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=deleted; Path=/; Max-Age=0; HttpOnly`); 

    return new Response("Logged out. Redirecting...", { status: 302, headers });
}


// ----------------------------------------------------
// Main Server Router
// ----------------------------------------------------

async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    
    // --- Public/Auth Routes ---
    if (pathname === "/login") return renderLoginForm();
    if (pathname === "/auth" && req.method === "POST") return handleAuth(req);
    if (pathname === "/logout") return handleLogout();
    
    // --- Utility Routes (For Setup) ---
    if (pathname === "/register") {
        const name = url.searchParams.get("name") || "test_user";
        const password = "password123";
        const success = await registerUser(name, password);
        return new Response(success ? `User '${name}' registered with 0 Ks balance.` : `User '${name}' already exists.`, { status: success ? 200 : 409 });
    }
    if (pathname === "/check") {
        const name = url.searchParams.get("name") || "test_user";
        const user = await getUserByUsername(name);
        return new Response(user ? `User: ${user.username}, Balance: ${user.balance} Ks` : `User '${name}' not found.`, { status: user ? 200 : 404 });
    }

    // --- Protected Routes ---
    const username = getUsernameFromCookie(req);
    
    // 1. Admin Route (Secured by Token)
    if (pathname === "/admin/topup") {
        return handleAdminTopUp(req);
    }

    // 2. Buy Route (Secured by Session)
    if (pathname === "/buy" && req.method === "POST") {
        if (!username) return handleLogout();
        return handleBuy(req, username);
    }

    // 3. Dashboard Route (Secured by Session)
    if (pathname === "/dashboard") {
        if (!username) return handleLogout();
        return handleDashboard(username);
    }
    
    // --- Default Route ---
    return new Response("Welcome to Deno E-Wallet. Go to /login", { status: 200 });
}

// Start the Deno Server
Deno.serve(handler);
