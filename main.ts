// Deno KV Database Setup
const kv = await Deno.openKv(); 

// --- Configuration and Security ---
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
        if (res.ok) {
            return true; 
        }
    }
}

// ----------------------------------------------------
// Authentication Helpers
// ----------------------------------------------------

function verifyPassword(inputPassword: string, storedHash: string): boolean {
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
// Admin Panel Functions (NEW)
// ----------------------------------------------------

function renderAdminPanel(token: string): Response {
    const html = `
        <!DOCTYPE html>
        <html lang="my">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Admin Top-Up Panel</title>
            <style>
                body { font-family: sans-serif; margin: 20px; background-color: #f4f7f6; }
                .container { max-width: 400px; margin: auto; padding: 20px; background-color: white; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                h1 { color: #007bff; }
                label { display: block; margin-top: 10px; font-weight: bold; }
                input[type="text"], input[type="number"] { width: 90%; padding: 10px; margin-top: 5px; border: 1px solid #ccc; border-radius: 4px; }
                button { background-color: #28a745; color: white; border: none; padding: 12px; margin-top: 20px; width: 100%; border-radius: 4px; cursor: pointer; }
            </style>
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
                <p style="margin-top: 30px;"><a href="/">Back to Home</a></p>
            </div>
        </body>
        </html>
    `;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// Admin Logic is now combined to handle GET (URL) and POST (Form) requests
async function handleAdminTopUp(req: Request): Promise<Response> {
    const url = new URL(req.url);

    let username, amount, token;

    if (req.method === "POST") {
        const formData = await req.formData();
        username = formData.get("name")?.toString();
        const amountStr = formData.get("amount")?.toString();
        amount = amountStr ? parseInt(amountStr) : NaN;
        token = formData.get("token")?.toString();
    } else { // GET request (for quick URL testing)
        username = url.searchParams.get("name");
        const amountStr = url.searchParams.get("amount");
        amount = amountStr ? parseInt(amountStr) : NaN;
        token = url.searchParams.get("token");
    }

    // 1. Authorization Check
    if (token !== ADMIN_TOKEN || ADMIN_TOKEN === "hardcoded_admin_pass") {
        return new Response("Authorization Failed: Invalid Token.", { status: 403 });
    }

    if (!username || isNaN(amount) || amount <= 0) {
        return new Response("Missing 'name' or invalid 'amount'.", { status: 400 });
    }

    // 2. Process Transaction
    const success = await updateUserBalance(username, amount);

    if (success) {
        const updatedUser = await getUserByUsername(username);
        return new Response(`SUCCESS: ${username} balance updated. New balance: ${updatedUser?.balance} Ks`, { status: 200, headers: { "Content-Type": "text/html" } });
    } else {
        return new Response(`ERROR: Failed to update balance for ${username}. User may not exist.`, { status: 500, headers: { "Content-Type": "text/html" } });
    }
}


// ----------------------------------------------------
// Main Server Router (Simplified)
// ----------------------------------------------------

async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    
    // --- Utility/Setup Routes ---
    if (pathname === "/register") { /* (Registration logic) */
        const name = url.searchParams.get("name") || "test_user";
        const password = "password123";
        const success = await registerUser(name, password);
        return new Response(success ? `User '${name}' registered with 0 Ks balance.` : `User '${name}' already exists.`, { status: success ? 200 : 409 });
    }
    if (pathname === "/check") { /* (Check logic) */
        const name = url.searchParams.get("name") || "test_user";
        const user = await getUserByUsername(name);
        return new Response(user ? `User: ${user.username}, Balance: ${user.balance} Ks` : `User '${name}' not found.`, { status: user ? 200 : 404 });
    }
    
    // --- Authentication & Main Routes ---
    if (pathname === "/login") return renderLoginForm();
    if (pathname === "/auth" && req.method === "POST") return handleAuth(req);
    if (pathname === "/logout") return handleLogout();

    // --- Admin Routes ---
    if (pathname === "/admin/panel") {
        const token = url.searchParams.get("token");
        if (token !== ADMIN_TOKEN) return new Response("Unauthorized.", { status: 403 });
        return renderAdminPanel(token); // Pass the token to the form
    }
    if (pathname === "/admin/topup") {
        return handleAdminTopUp(req); // Handles both GET and POST
    }
    
    // --- Protected Routes (Dashboard & Buy) ---
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
    return new Response("Welcome to Deno E-Wallet. Go to /login", { status: 200 });
}

// Start the Deno Server
Deno.serve(handler);
