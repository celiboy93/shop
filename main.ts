// Deno KV Database Setup
const kv = await Deno.openKv(); 

// --- Configuration and Security ---
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") || "hardcoded_admin_pass"; 
const SESSION_COOKIE_NAME = "session_id";
// NEW: Define Myanmar Timezone
const MYANMAR_TIMEZONE = "Asia/Yangon";

// --- Data Structures ---
interface User {
    username: string;
    passwordHash: string;
    balance: number;
}
interface Transaction {
    type: "topup" | "purchase";
    amount: number;
    timestamp: string; // Stored in UTC
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
    const res = await kv.atomic().check({ key, versionstamp: null }).set(key, user).commit();
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
        if (res.ok) return true; 
    }
}

async function logTransaction(username: string, amount: number, type: "topup" | "purchase"): Promise<void> {
    const timestamp = new Date().toISOString(); // Always store in UTC
    const key = ["transactions", username, timestamp]; 
    const transaction: Transaction = { type, amount, timestamp };
    await kv.set(key, transaction);
}

async function getTransactions(username: string): Promise<Transaction[]> {
    const entries = kv.list<Transaction>({ prefix: ["transactions", username] }, { reverse: true });
    const transactions: Transaction[] = [];
    for await (const entry of entries) {
        transactions.push(entry.value);
    }
    return transactions;
}

// ----------------------------------------------------
// Authentication Helpers
// ----------------------------------------------------

function verifyPassword(inputPassword: string, storedHash: string): boolean {
    return inputPassword === storedHash;
}

function getUsernameFromCookie(req: Request): string | null {
    const cookieHeader = req.headers.get("Cookie");
    if (!cookieHeader || !cookieHeader.includes(SESSION_COOKIE_NAME)) return null;
    try {
        const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
        return match ? match[1].split(';')[0] : null;
    } catch {
        return null;
    }
}

function createSession(username: string): Headers {
    const headers = new Headers();
    const sessionId = username; 
    headers.set("Location", "/dashboard");
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; Max-Age=3600; HttpOnly`);
    return headers;
}

// ----------------------------------------------------
// HTML Render Functions (Pages)
// ----------------------------------------------------

function renderLoginForm(): Response {
    const html = `
        <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Login</title><style>body{font-family:sans-serif; margin:20px;} button{background-color:#007bff; color:white; border:none; padding:10px 20px; border-radius:5px; cursor:pointer;}</style></head>
        <body><h1>User Login</h1><form action="/auth" method="POST"><label for="username">Name:</label><br><input type="text" id="username" name="username" required><br><br><label for="password">Password:</label><br><input type="password" id="password" name="password" required><br><br><button type="submit">Log In</button></form>
        <p style="margin-top:20px;">Don't have an account? <a href="/register">Register Here</a></p></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function renderRegisterForm(req: Request): Response {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    const html = `
        <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Register</title><style>body{font-family:sans-serif; margin:20px;} button{background-color:#28a745; color:white; border:none; padding:10px 20px; border-radius:5px; cursor:pointer;} .error{color:red;}</style></head>
        <body><h1>Create Account</h1>
        ${error === 'exists' ? '<p class="error">This username is already taken. Please choose another one.</p>' : ''}
        <form action="/doregister" method="POST"><label for="username">Choose Name:</label><br><input type="text" id="username" name="username" required><br><br><label for="password">Choose Password:</label><br><input type="password" id="password" name="password" required><br><br><button type="submit">Create Account</button></form>
        <p style="margin-top:20px;">Already have an account? <a href="/login">Login</a></p></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function renderAdminPanel(token: string): Response {
    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin Top-Up Panel</title><style>body{font-family:sans-serif; margin:20px; background-color:#f4f7f6;} .container{max-width:400px; margin:auto; padding:20px; background-color:white; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1);} h1{color:#007bff;} label{display:block; margin-top:10px; font-weight:bold;} input{width:90%; padding:10px; margin-top:5px; border:1px solid #ccc; border-radius:4px;} button{background-color:#28a745; color:white; border:none; padding:12px; margin-top:20px; width:100%; border-radius:4px; cursor:pointer;}</style></head>
        <body><div class="container"><h1>Admin Top-Up</h1><form action="/admin/topup" method="POST"><input type="hidden" name="token" value="${token}"><label for="username">User Name:</label><input type="text" id="username" name="name" required placeholder="e.g., ko_aung"><br><label for="amount">Amount (Ks):</label><input type="number" id="amount" name="amount" required placeholder="e.g., 2000"><br><button type="submit">Add Balance</button></form></div></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

async function handleDashboard(username: string): Promise<Response> {
    const user = await getUserByUsername(username);
    if (!user) return handleLogout(); 
    
    const coffeePrice = 2000;
    const teaPrice = 1500;
    
    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shop Dashboard</title><style>body{font-family:sans-serif; margin:0; padding:0; background-color:#f4f7f6;} .container{max-width:600px; margin:30px auto; padding:20px; background-color:white; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1);} h1{color:#333; border-bottom:2px solid #eee; padding-bottom:10px;} .balance-box{background-color:#e6f7ff; padding:15px; border-radius:5px; margin-bottom:20px;} .balance-amount{font-size:2em; color:#007bff; font-weight:bold;} .item-card{border:1px solid #ddd; padding:15px; margin-bottom:15px; border-radius:5px; display:flex; justify-content:space-between; align-items:center;} .item-info h3{margin-top:0; color:#555; font-size:1.2em;} .price{font-weight:bold; color:#28a745; margin-left:10px;} .buy-btn{background-color:#28a745; color:white; border:none; padding:10px 15px; border-radius:5px; cursor:pointer;} .disabled{background-color:#dc3545; cursor:not-allowed; opacity:0.7;} .nav-links{display:flex; justify-content:space-between; margin-top:20px;}</style></head>
        <body><div class="container"><h1>Welcome, ${user.username}!</h1>
        <div class="balance-box"><span>Current Balance:</span><div class="balance-amount">${user.balance} Ks</div></div>
        <h2>🛒 Shop Items:</h2>
        
        <div class="item-card">
            <div class="item-info"><h3>☕ Coffee <span class="price">(${coffeePrice} Ks)</span></h3></div>
            <form action="/buy" method="POST" onsubmit="return confirm('Are you sure you want to buy Coffee for ${coffeePrice} Ks?');">
                <input type="hidden" name="item" value="Coffee"><input type="hidden" name="price" value="${coffeePrice}">
                <button type="submit" class="buy-btn ${user.balance < coffeePrice ? 'disabled' : ''}" ${user.balance < coffeePrice ? 'disabled' : ''}>
                    ${user.balance < coffeePrice ? 'Insufficient Balance' : 'Buy Now'}
                </button>
            </form>
        </div>
        
        <div class="item-card">
            <div class="item-info"><h3>🍵 Tea <span class="price">(${teaPrice} Ks)</span></h3></div>
            <form action="/buy" method="POST" onsubmit="return confirm('Are you sure you want to buy Tea for ${teaPrice} Ks?');">
                <input type="hidden" name="item" value="Tea"><input type="hidden" name="price" value="${teaPrice}">
                <button type="submit" class="buy-btn ${user.balance < teaPrice ? 'disabled' : ''}" ${user.balance < teaPrice ? 'disabled' : ''}>
                    ${user.balance < teaPrice ? 'Insufficient Balance' : 'Buy Now'}
                </button>
            </form>
        </div>
        
        <div class="nav-links"><a href="/user-info">My Info</a><a href="/logout" style="color:red;">Logout</a></div></div></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ROUTE: /user-info (UPDATED with Timezone)
async function handleUserInfoPage(username: string): Promise<Response> {
    const user = await getUserByUsername(username);
    if (!user) return handleLogout();

    const transactions = await getTransactions(username);
    
    // Function to convert UTC string to Myanmar Time string
    function toMyanmarTime(utcString: string): string {
        return new Date(utcString).toLocaleString("en-US", {
            timeZone: MYANMAR_TIMEZONE, // "Asia/Yangon"
            year: 'numeric', month: 'numeric', day: 'numeric',
            hour: 'numeric', minute: 'numeric', hour12: true
        });
    }

    // Generate HTML for transaction history
    const topUpHistory = transactions
        .filter(t => t.type === 'topup')
        .map(t => `<li>On ${toMyanmarTime(t.timestamp)}, you received <strong>${t.amount} Ks</strong>.</li>`)
        .join('');
        
    const purchaseHistory = transactions
        .filter(t => t.type === 'purchase')
        .map(t => `<li>On ${toMyanmarTime(t.timestamp)}, you bought an item for <strong>${Math.abs(t.amount)} Ks</strong>.</li>`)
        .join('');

    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My Info</title><style>body{font-family:sans-serif; margin:20px; background-color:#f4f7f6;} .container{max-width:600px; margin:auto; padding:20px; background-color:white; border-radius:8px; box-shadow:0 4px 6px rgba(0,0,0,0.1);} h1{color:#333;} .info-item{font-size:1.2em; margin-bottom:10px;} .history{margin-top:20px;} ul{padding-left: 20px;}</style></head>
        <body><div class="container">
            <h1>My User Info</h1>
            <div class="info-item"><strong>Username:</strong> ${user.username}</div>
            <div class="info-item"><strong>Balance:</strong> ${user.balance} Ks</div>
            <p style="font-size:0.9em; color:gray;">(For security, passwords are never shown.)</p>
            
            <div class="history">
                <h2>Top-Up History</h2>
                ${topUpHistory.length > 0 ? `<ul>${topUpHistory}</ul>` : '<p>You have not received any top-ups yet.</p>'}
            </div>
            
            <div class="history">
                <h2>Purchase History</h2>
                ${purchaseHistory.length > 0 ? `<ul>${purchaseHistory}</ul>` : '<p>You have not made any purchases yet.</p>'}
            </div>
            
            <a href="/dashboard">Back to Shop</a>
        </div></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}


// ----------------------------------------------------
// Action Handlers (Processing POST requests)
// ----------------------------------------------------

async function handleAuth(req: Request): Promise<Response> {
    const formData = await req.formData();
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();

    if (!username || !password) return new Response("Missing username or password.", { status: 400 });
    const user = await getUserByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) return new Response("Invalid username or password.", { status: 401 });

    const headers = createSession(username); 
    return new Response("Login successful. Redirecting...", { status: 302, headers });
}

async function handleRegister(req: Request): Promise<Response> {
    const formData = await req.formData();
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();

    if (!username || !password) return new Response("Missing username or password.", { status: 400 });

    const passwordHash = password; 
    const success = await registerUser(username, passwordHash);

    if (success) {
        const headers = createSession(username); 
        return new Response("Account created. Logging in...", { status: 302, headers });
    } else {
        const headers = new Headers();
        headers.set("Location", "/register?error=exists");
        return new Response("User exists. Redirecting...", { status: 302, headers });
    }
}

// UPDATED: handleBuy with clearer messages
async function handleBuy(req: Request, username: string): Promise<Response> {
    const formData = await req.formData();
    const item = formData.get("item")?.toString();
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;

    if (!item || isNaN(price) || price <= 0) {
        return new Response(`Invalid item or price. <a href="/dashboard">Back</a>`, { status: 400, headers: { "Content-Type": "text/html" } });
    }

    // Pre-check balance for a clearer error message
    const user = await getUserByUsername(username);
    if (!user) return handleLogout(); // Should not happen
    if (user.balance < price) {
        return new Response(`Purchase Failed: Insufficient Balance. You have ${user.balance} Ks but need ${price} Ks. <a href="/dashboard">Back</a>`, { status: 400, headers: { "Content-Type": "text/html" } });
    }

    // Attempt the transaction
    const success = await updateUserBalance(username, -price); 

    if (success) {
        await logTransaction(username, -price, "purchase");
        const newBalance = user.balance - price;
        return new Response(`Purchase Successful! You bought ${item} for ${price} Ks. Your new balance is ${newBalance} Ks. <a href="/dashboard">Back to Dashboard</a>`, { status: 200, headers: { "Content-Type": "text/html" } });
    } else {
        // This is a fallback, but the pre-check should catch most errors
        return new Response(`Transaction failed (e.g., balance changed during transaction). <a href="/dashboard">Back to Dashboard</a>`, { status: 400, headers: { "Content-Type": "text/html" } });
    }
}

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
        await logTransaction(username, amount, "topup");
        const updatedUser = await getUserByUsername(username);
        return new Response(`SUCCESS: ${username} balance updated. New balance: ${updatedUser?.balance} Ks`, { status: 200, headers: { "Content-Type": "text/html" } });
    } else {
        return new Response(`ERROR: Failed to update balance for ${username}. User may not exist.`, { status: 500, headers: { "Content-Type": "text/html" } });
    }
}

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
    
    if (pathname === "/user-info") {
        if (!username) return handleLogout();
        return handleUserInfoPage(username);
    }
    
    // --- Default Route ---
    const headers = new Headers();
    headers.set("Location", "/login");
    return new Response("Redirecting to /login...", { status: 302, headers });
}

// Start the Deno Server
Deno.serve(handler);
