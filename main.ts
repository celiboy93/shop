// Deno KV Database Setup
const kv = await Deno.openKv(); 

// --- Configuration and Security ---
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") || "hardcoded_admin_pass"; 
const SESSION_COOKIE_NAME = "session_id";

// --- User Data Structure ---
interface User {
    username: string;
    passwordHash: string;
    balance: number;
}

// ----------------------------------------------------
// Core KV Functions (Data Management)
// ----------------------------------------------------

async function getUserByUsername(username: string): Promise<User | null> {
    const key = ["users", username];
    const result = await kv.get<User>(key);
    return result.value;
}

/**
 * Registers a new user with an initial balance of 0.
 * Returns true on success, false if user already exists.
 */
async function registerUser(username: string, passwordHash: string): Promise<boolean> {
    const user: User = { username, passwordHash, balance: 0 };
    const key = ["users", username];

    const res = await kv.atomic()
        .check({ key, versionstamp: null }) // Check if user does NOT exist
        .set(key, user)
        .commit();

    return res.ok;
}

async function updateUserBalance(username: string, amountChange: number): Promise<boolean> {
    const key = ["users", username];
    
    while (true) {
        const result = await kv.get<User>(key);
        const user = result.value;
        if (!user) return false; 
        const newBalance = user.balance + amountChange;
        if (newBalance < 0) return false; 
        const res = await kv.atomic().check(result).set(key, { ...user, balance: newBalance }).commit();
        if (res.ok) {
            return true; 
        }
    }
}

// ----------------------------------------------------
// Authentication Helpers
// ----------------------------------------------------

function verifyPassword(inputPassword: string, storedHash: string): boolean {
    // SECURITY WARNING: In a real app, use bcrypt!
    return inputPassword === storedHash;
}

function getUsernameFromCookie(req: Request): string | null {
    const cookieHeader = req.headers.get("Cookie");
    if (!cookieHeader || !cookieHeader.includes(SESSION_COOKIE_NAME)) {
        return null;
    }
    try {
        const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
        return match ? match[1].split(';')[0] : null;
    } catch {
        return null;
    }
}

// ----------------------------------------------------
// HTML Render Functions (Pages)
// ----------------------------------------------------

// ROUTE: /login (Display login form)
function renderLoginForm(): Response {
    const html = `
        <!DOCTYPE html>
        <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Login</title>
        <style>body{font-family:sans-serif; margin:20px;} button{background-color:#007bff; color:white; border:none; padding:10px 20px; border-radius:5px; cursor:pointer;}</style>
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
            <p style="margin-top:20px;">Don't have an account? <a href="/register">Register Here</a></p>
        </body>
        </html>
    `;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ROUTE: /register (Display registration form) - NEW
function renderRegisterForm(req: Request): Response {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    
    const html = `
        <!DOCTYPE html>
        <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Register</title>
        <style>body{font-family:sans-serif; margin:20px;} button{background-color:#28a745; color:white; border:none; padding:10px 20px; border-radius:5px; cursor:pointer;} .error{color:red;}</style>
        </head>
        <body>
            <h1>Create Account</h1>
            ${error === 'exists' ? '<p class="error">This username is already taken. Please choose another one.</p>' : ''}
            <form action="/doregister" method="POST">
                <label for="username">Choose Name:</label><br>
                <input type="text" id="username" name="username" required><br><br>
                <label for="password">Choose Password:</label><br>
                <input type="password" id="password" name="password" required><br><br>
                <button type="submit">Create Account</button>
            </form>
            <p style="margin-top:20px;">Already have an account? <a href="/login">Login</a></p>
        </body>
        </html>
    `;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ROUTE: /admin/panel (Display admin top-up form)
function renderAdminPanel(token: string): Response {
    const html = `
        <!DOCTYPE html>
        <html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin Top-Up Panel</title>
        <style>body{font-family:sans-serif; margin:20px; background-color:#f4f7f6;} .container{max-width:400px; margin:auto; padding:20px; background-color:white; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1);} h1{color:#007bff;} label{display:block; margin-top:10px; font-weight:bold;} input{width:90%; padding:10px; margin-top:5px; border:1px solid #ccc; border-radius:4px;} button{background-color:#28a745; color:white; border:none; padding:12px; margin-top:20px; width:100%; border-radius:4px; cursor:pointer;}</style>
        </head>
        <body>
            <div class="container">
                <h1>Admin Top-Up</h1>
                <form action="/admin/topup" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <label for="username">User Name:</label>
                    <input type="text" id="username" name="name" required placeholder="e.g., ko_aung"><br>
                    <label for="amount">Amount (Ks):</label>
                    <input type="number" id="amount" name="amount" required placeholder="e.g., 2000"><br>
                    <button type="submit">Add Balance</button>
                </form>
            </div>
        </body>
        </html>
    `;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ROUTE: /dashboard (Show user info and shop items)
async function handleDashboard(username: string): Promise<Response> {
    const user = await getUserByUsername(username);
    if (!user) return handleLogout(); 
    
    const coffeePrice = 2000;
    const teaPrice = 1500;
    
    const html = `
        <!DOCTYPE html>
        <html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shop Dashboard</title>
        <style>body{font-family:sans-serif; margin:0; padding:0; background-color:#f4f7f6;} .container{max-width:600px; margin:30px auto; padding:20px; background-color:white; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1);} h1{color:#333; border-bottom:2px solid #eee; padding-bottom:10px;} .balance-box{background-color:#e6f7ff; padding:15px; border-radius:5px; margin-bottom:20px;} .balance-amount{font-size:2em; color:#007bff; font-weight:bold;} .item-card{border:1px solid #ddd; padding:15px; margin-bottom:15px; border-radius:5px; display:flex; justify-content:space-between; align-items:center;} .item-info h3{margin-top:0; color:#555; font-size:1.2em;} .price{font-weight:bold; color:#28a745; margin-left:10px;} .buy-btn{background-color:#28a745; color:white; border:none; padding:10px 15px; border-radius:5px; cursor:pointer;} .disabled{background-color:#dc3545; cursor:not-allowed; opacity:0.7;} .logout-link{display:block; margin-top:20px; text-align:center; color:#007bff;}</style>
        </head>
        <body>
            <div class="container">
                <h1>Welcome, ${user.username}!</h1>
                <div class="balance-box">
                    <span>Current Balance:</span>
                    <div class="balance-amount">${user.balance} Ks</div>
                </div>
                <h2>🛒 Shop Items:</h2>
                <div class="item-card">
                    <div class="item-info"><h3>☕ Coffee <span class="price">(${coffeePrice} Ks)</span></h3></div>
                    <form action="/buy" method="POST">
                        <input type="hidden" name="item" value="Coffee"><input type="hidden" name="price" value="${coffeePrice}">
                        <button type="submit" class="buy-btn ${user.balance < coffeePrice ? 'disabled' : ''}" ${user.balance < coffeePrice ? 'disabled' : ''}>${user.balance < coffeePrice ? 'Insufficient Balance' : 'Buy Now'}</button>
                    </form>
                </div>
                <div class="item-card">
                    <div class="item-info"><h3>🍵 Tea <span class="price">(${teaPrice} Ks)</span></h3></div>
                    <form action="/buy" method="POST">
                        <input type="hidden" name="item" value="Tea"><input type="hidden" name="price" value="${teaPrice}">
                        <button type="submit" class="buy-btn ${user.balance < teaPrice ? 'disabled' : ''}" ${user.balance < teaPrice ? 'disabled' : ''}>${user.balance < teaPrice ? 'Insufficient Balance' : 'Buy Now'}</button>
                    </form>
                </div>
                <a href="/logout" class="logout-link">Logout</a>
            </div>
        </body>
        </html>
    `;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ----------------------------------------------------
// Action Handlers (Processing POST requests)
// ----------------------------------------------------

// ROUTE: /auth (Process login form submission)
async function handleAuth(req: Request): Promise<Response> {
    const formData = await req.formData();
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();

    if (!username || !password) return new Response("Missing username or password.", { status: 400 });

    const user = await getUserByUsername(username);

    if (!user || !verifyPassword(password, user.passwordHash)) {
        return new Response("Invalid username or password.", { status: 401 });
    }

    const sessionId = username; 
    const headers = new Headers();
    headers.set("Location", "/dashboard");
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; Max-Age=3600; HttpOnly`); 
    return new Response("Login successful. Redirecting...", { status: 302, headers });
}

// ROUTE: /doregister (Process registration form) - NEW
async function handleRegister(req: Request): Promise<Response> {
    const formData = await req.formData();
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();

    if (!username || !password) return new Response("Missing username or password.", { status: 400 });

    // NOTE: Hash password here in a real app
    const passwordHash = password; 

    const success = await registerUser(username, passwordHash);

    const headers = new Headers();
    if (success) {
        // Success, redirect to login page
        headers.set("Location", "/login");
        return new Response("Account created. Redirecting to login...", { status: 302, headers });
    } else {
        // Fail (User exists), redirect back to register page with error
        headers.set("Location", "/register?error=exists");
        return new Response("User exists. Redirecting...", { status: 302, headers });
    }
}

// ROUTE: /buy (Process purchase transaction)
async function handleBuy(req: Request, username: string): Promise<Response> {
    const formData = await req.formData();
    const item = formData.get("item")?.toString();
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;

    if (!item || isNaN(price) || price <= 0) return new Response(`Invalid item or price. <a href="/dashboard">Back</a>`, { status: 400, headers: { "Content-Type": "text/html" } });

    const success = await updateUserBalance(username, -price); 

    if (success) {
        return new Response(`Successfully bought ${item} for ${price} Ks. <a href="/dashboard">Back to Dashboard</a>`, { status: 200, headers: { "Content-Type": "text/html" } });
    } else {
        return new Response(`Transaction failed (Insufficient Balance or Error). <a href="/dashboard">Back to Dashboard</a>`, { status: 400, headers: { "Content-Type": "text/html" } });
    }
}

// ROUTE: /admin/topup (Process top-up from URL or Form)
async function handleAdminTopUp(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let username, amount, token;

    if (req.method === "POST") {
        const formData = await req.formData();
        username = formData.get("name")?.toString();
        const amountStr = formData.get("amount")?.toString();
        amount = amountStr ? parseInt(amountStr) : NaN;
        token = formData.get("token")?.toString();
    } else { 
        username = url.searchParams.get("name");
        const amountStr = url.searchParams.get("amount");
        amount = amountStr ? parseInt(amountStr) : NaN;
        token = url.searchParams.get("token");
    }

    if (token !== ADMIN_TOKEN || ADMIN_TOKEN === "hardcoded_admin_pass") return new Response("Authorization Failed: Invalid Token.", { status: 403 });
    if (!username || isNaN(amount) || amount <= 0) return new Response("Missing 'name' or invalid 'amount'.", { status: 400 });

    const success = await updateUserBalance(username, amount);

    if (success) {
        const updatedUser = await getUserByUsername(username);
        return new Response(`SUCCESS: ${username} balance updated. New balance: ${updatedUser?.balance} Ks`, { status: 200, headers: { "Content-Type": "text/html" } });
    } else {
        return new Response(`ERROR: Failed to update balance for ${username}. User may not exist.`, { status: 500, headers: { "Content-Type": "text/html" } });
    }
}

// ROUTE: /logout
function handleLogout(): Response {
    const headers = new Headers();
    headers.set("Location", "/login");
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=deleted; Path=/; Max-Age=0; HttpOnly`); 
    return new Response("Logged out. Redirecting...", { status: 302, headers });
}

// ----------------------------------------------------
// Main Server Router
// ----------------------------------------------------

async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    
    // --- Public Routes ---
    if (pathname === "/login") return renderLoginForm();
    if (pathname === "/register") return renderRegisterForm(req);
    if (pathname === "/auth" && req.method === "POST") return handleAuth(req);
    if (pathname === "/doregister" && req.method === "POST") return handleRegister(req);
    if (pathname === "/logout") return handleLogout();
    
    // --- Admin Routes ---
    if (pathname === "/admin/panel") {
        const token = url.searchParams.get("token");
        if (token !== ADMIN_TOKEN) return new Response("Unauthorized.", { status: 403 });
        return renderAdminPanel(token); 
    }
    if (pathname === "/admin/topup") {
        return handleAdminTopUp(req); 
    }
    
    // --- Protected Routes (Must be logged in) ---
    const username = getUsernameFromCookie(req);

    if (pathname === "/buy" && req.method === "POST") {
        if (!username) return handleLogout();
        return handleBuy(req, username);
    }
    
    if (pathname === "/dashboard") {
        if (!username) return handleLogout();
        return handleDashboard(username);
    }
    
    // --- Default Route ---
    // Redirect / to /login
    const headers = new Headers();
    headers.set("Location", "/login");
    return new Response("Redirecting to /login...", { status: 302, headers });
}

// Start the Deno Server
Deno.serve(handler);
