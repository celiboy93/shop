// Deno KV Database Setup
const kv = await Deno.openKv(); 

// --- Configuration and Security ---
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") || "hardcoded_admin_pass"; 
const SESSION_COOKIE_NAME = "session_id";
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
interface Product {
    id: string; // e.g., "1678886400000"
    name: string; // e.g., "☕ Coffee"
    price: number; // e.g., 2000
    imageUrl: string; // e.g., "https://.../coffee.jpg" or emoji
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

// This is the final security check for balance
async function updateUserBalance(username: string, amountChange: number): Promise<boolean> {
    const key = ["users", username];
    while (true) {
        const result = await kv.get<User>(key);
        const user = result.value;
        if (!user) return false; 
        const newBalance = user.balance + amountChange;
        if (newBalance < 0) return false; // This prevents overdraft
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

async function getProducts(): Promise<Product[]> {
    const entries = kv.list<Product>({ prefix: ["products"] });
    const products: Product[] = [];
    for await (const entry of entries) {
        products.push(entry.value);
    }
    return products.sort((a, b) => parseInt(a.id) - parseInt(b.id)); // Sort by time added
}

async function addProduct(name: string, price: number, imageUrl: string): Promise<boolean> {
    const id = Date.now().toString(); // Use timestamp as simple ID
    const product: Product = { id, name, price, imageUrl };
    const key = ["products", id];
    const res = await kv.set(key, product);
    return res.ok;
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

const globalStyles = `
    body { font-family: sans-serif; margin: 0; padding: 0; background-color: #f4f7f6; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
    .container { max-width: 600px; width: 90%; margin: 30px auto; padding: 30px; background-color: white; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); }
    h1 { color: #333; } h2 { border-bottom: 1px solid #eee; padding-bottom: 5px; }
    a { color: #007bff; text-decoration: none; }
    button { background-color: #007bff; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
    .error { color: red; }
    input[type="text"], input[type="password"], input[type="number"], input[type="url"] { width: 90%; padding: 10px; margin-top: 5px; border: 1px solid #ccc; border-radius: 4px; }
`;

function renderLoginForm(): Response {
    const html = `
        <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Login</title><style>${globalStyles}</style></head>
        <body>
            <div class="container">
                <h1>User Login</h1>
                <form action="/auth" method="POST">
                    <label for="username">Name:</label><br>
                    <input type="text" id="username" name="username" required><br><br>
                    <label for="password">Password:</label><br>
                    <input type="password" id="password" name="password" required><br><br>
                    <button type="submit">Log In</button>
                </form>
                <p style="margin-top:20px;">Don't have an account? <a href="/register">Register Here</a></p>
            </div>
        </body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

function renderRegisterForm(req: Request): Response {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    const html = `
        <!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Register</title><style>${globalStyles} button.register{background-color:#28a745;}</style></head>
        <body>
            <div class="container">
                <h1>Create Account</h1>
                ${error === 'exists' ? '<p class="error">This username is already taken.</p>' : ''}
                <form action="/doregister" method="POST">
                    <label for="username">Choose Name:</label><br>
                    <input type="text" id="username" name="username" required><br><br>
                    <label for="password">Choose Password:</label><br>
                    <input type="password" id="password" name="password" required><br><br>
                    <button type="submit" class="register">Create Account</button>
                </form>
                <p style="margin-top:20px;">Already have an account? <a href="/login">Login</a></p>
            </div>
        </body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// UPDATED: Admin Panel now includes success messages
function renderAdminPanel(token: string, message: string | null): Response {
    let messageHtml = "";
    if (message === "topup_success") {
        messageHtml = `<div class="success-msg">User balance updated successfully!</div>`;
    }
    if (message === "product_added") {
        messageHtml = `<div class="success-msg">Product added successfully!</div>`;
    }

    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin Panel</title>
        <style>${globalStyles} button.admin{background-color:#28a745; width: 100%;} button.product{background-color:#ffc107; color:black; width:100%;} hr{margin: 30px 0;} .success-msg { padding: 10px; background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; border-radius: 5px; margin-bottom: 15px; }</style></head>
        <body>
            <div class="container">
                ${messageHtml}
                <h2>User Top-Up</h2>
                <form action="/admin/topup" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <label for="username">User Name:</label>
                    <input type="text" id="username" name="name" required placeholder="e.g., ko_aung"><br><br>
                    <label for="amount">Amount (Ks):</label>
                    <input type="number" id="amount" name="amount" required placeholder="e.g., 2000"><br><br>
                    <button type="submit" class="admin">Add Balance</button>
                </form>
                
                <hr>
                
                <h2>Add New Product</h2>
                <form action="/admin/add_product" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <label for="productName">Product Name:</label>
                    <input type="text" id="productName" name="name" required placeholder="e.g., ☕ Coffee"><br><br>
                    <label for="productPrice">Price (Ks):</label>
                    <input type="number" id="productPrice" name="price" required placeholder="e.g., 2000"><br><br>
                    <label for="imageUrl">Image URL (or Emoji):</label>
                    <input type="url" id="imageUrl" name="imageUrl" required placeholder="https://.../image.jpg (or paste ☕)"><br><br>
                    <button type="submit" class="product">Add Product</button>
                </form>
            </div>
        </body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// UPDATED: renderMessagePage now has a flexible back link
function renderMessagePage(title: string, message: string, isError = false, backLink: string | null = null): Response {
    const borderColor = isError ? "#dc3545" : "#28a745";
    const linkHref = backLink || "/dashboard";
    const linkText = backLink ? "Go Back" : "Back to Shop";

    const html = `
        <!DOCTYPE html><html><head><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            ${globalStyles}
            .container { text-align: center; border-top: 5px solid ${borderColor}; }
            .message { font-size: 1.2em; color: ${isError ? '#dc3545' : '#333'}; }
        </style>
        </head>
        <body><div class="container">
            <h1>${title}</h1>
            <p class="message">${message}</p>
            <br>
            <a href="${linkHref}">${linkText}</a>
        </div></body></html>`;
    return new Response(html, { status: isError ? 400 : 200, headers: { "Content-Type": "text/html" } });
}

// UPDATED: Dashboard now reads products from KV
async function handleDashboard(username: string): Promise<Response> {
    const user = await getUserByUsername(username);
    if (!user) return handleLogout(); 
    
    // Get all products from database
    const products = await getProducts();
    
    // Dynamically create product cards
    const productListHtml = products.map(product => `
        <div class="item-card">
            <div class="item-info">
                <h3>${product.imageUrl.startsWith('http') ? `<img src="${product.imageUrl}" alt="${product.name}" height="40" style="vertical-align:middle; margin-right:10px;">` : product.imageUrl} ${product.name} 
                    <span class="price">(${product.price} Ks)</span>
                </h3>
            </div>
            <form method="POST" action="/buy" onsubmit="return checkBalance('${product.name}', ${product.price}, ${user.balance});">
                <input type="hidden" name="item" value="${product.name}">
                <input type="hidden" name="price" value="${product.price}">
                <button type="submit" class="buy-btn">Buy Now</button>
            </form>
        </div>
    `).join('');
    
    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shop Dashboard</title>
        <style>${globalStyles} .balance-box{background-color:#e6f7ff; padding:15px; border-radius:5px; margin-bottom:20px;} .balance-amount{font-size:2em; color:#007bff; font-weight:bold;} .item-card{border:1px solid #ddd; padding:15px; margin-bottom:15px; border-radius:5px; display:flex; justify-content:space-between; align-items:center;} .item-info h3{margin-top:0; color:#555; font-size:1.2em;} .price{font-weight:bold; color:#28a745; margin-left:10px;} .buy-btn{background-color:#28a745; color:white; border:none; padding:10px 15px; border-radius:5px; cursor:pointer;} .nav-links{display:flex; justify-content:space-between; margin-top:20px;}</style>
        </head>
        <body><div class="container"><h1>Welcome, ${user.username}!</h1>
        <div class="balance-box"><span>Current Balance:</span><div class="balance-amount">${user.balance} Ks</div></div>
        <h2>🛒 Shop Items:</h2>
        
        ${products.length > 0 ? productListHtml : '<p>No products available yet. Check back soon!</p>'}
        
        <div class="nav-links"><a href="/user-info">My Info</a><a href="/logout" style="color:red;">Logout</a></div></div>
        
        <script>
            function checkBalance(itemName, price, balance) {
                if (balance < price) {
                    alert("Insufficient Balance!\\nYou have " + balance + " Ks but need " + price + " Ks.\\nPlease contact admin for a top-up.");
                    return false; // Stop the form submission
                }
                return confirm("Are you sure you want to buy " + itemName + " for " + price + " Ks?");
            }
        </script>
        </body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ROUTE: /user-info (UPDATED with Timezone)
async function handleUserInfoPage(username: string): Promise<Response> {
    const user = await getUserByUsername(username);
    if (!user) return handleLogout();

    const transactions = await getTransactions(username);
    
    function toMyanmarTime(utcString: string): string {
        try { return new Date(utcString).toLocaleString("en-US", { timeZone: MYANMAR_TIMEZONE, hour12: true }); } 
        catch (e) { return utcString; }
    }

    const topUpHistory = transactions.filter(t => t.type === 'topup')
        .map(t => `<li>On ${toMyanmarTime(t.timestamp)}, you received <strong>${t.amount} Ks</strong>.</li>`).join('');
    const purchaseHistory = transactions.filter(t => t.type === 'purchase')
        .map(t => `<li>On ${toMyanmarTime(t.timestamp)}, you bought an item for <strong>${Math.abs(t.amount)} Ks</strong>.</li>`).join('');

    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My Info</title><style>${globalStyles} .info-item{font-size:1.2em; margin-bottom:10px;} .history{margin-top:20px;} ul{padding-left: 20px;}</style></head>
        <body><div class="container"><h1>My User Info</h1>
        <div class="info-item"><strong>Username:</strong> ${user.username}</div>
        <div class="info-item"><strong>Balance:</strong> ${user.balance} Ks</div>
        <p style="font-size:0.9em; color:gray;">(For security, passwords are never shown.)</p>
        <div class="history"><h2>Top-Up History</h2>${topUpHistory.length > 0 ? `<ul>${topUpHistory}</ul>` : '<p>You have not received any top-ups yet.</p>'}</div>
        <div class="history"><h2>Purchase History</h2>${purchaseHistory.length > 0 ? `<ul>${purchaseHistory}</ul>` : '<p>You have not made any purchases yet.</p>'}</div>
        <a href="/dashboard">Back to Shop</a></div></body></html>`;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}


// ----------------------------------------------------
// Action Handlers (Processing POST requests)
// ----------------------------------------------------

async function handleAuth(req: Request): Promise<Response> {
    const formData = await req.formData();
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();

    if (!username || !password) return renderMessagePage("Login Failed", "Missing username or password.", true, "/login");
    const user = await getUserByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) return renderMessagePage("Login Failed", "Invalid username or password.", true, "/login");
    
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

async function handleBuy(req: Request, username: string): Promise<Response> {
    const formData = await req.formData();
    const item = formData.get("item")?.toString();
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;

    if (!item || isNaN(price) || price <= 0) {
        return renderMessagePage("Error", "Invalid item or price.", true);
    }

    // Server-side balance check (final security)
    const success = await updateUserBalance(username, -price); 

    if (success) {
        await logTransaction(username, -price, "purchase");
        const newBalance = (await getUserByUsername(username))?.balance ?? 0;
        const message = `You bought <strong>${item}</strong> for ${price} Ks.<br>Your new balance is <strong>${newBalance} Ks</strong>.`;
        return renderMessagePage("Purchase Successful!", message, false);
    } else {
        const user = await getUserByUsername(username);
        const message = `You have ${user?.balance ?? 0} Ks but need ${price} Ks. Please contact admin for a top-up.`;
        return renderMessagePage("Insufficient Balance", message, true);
    }
}

// UPDATED: Now takes formData
async function handleAdminTopUp(formData: FormData): Promise<Response> {
    const username = formData.get("name")?.toString();
    const amountStr = formData.get("amount")?.toString();
    const amount = amountStr ? parseInt(amountStr) : NaN;
    const token = formData.get("token")?.toString();
    const adminBackLink = `/admin/panel?token=${token}`;
    
    if (!username || isNaN(amount) || amount <= 0) {
        return renderMessagePage("Error", "Missing 'name' or invalid 'amount'.", true, adminBackLink);
    }

    const success = await updateUserBalance(username, amount);

    if (success) {
        await logTransaction(username, amount, "topup");
        // Redirect back to admin panel with success message
        const headers = new Headers();
        headers.set("Location", `/admin/panel?token=${token}&message=topup_success`);
        return new Response("Redirecting...", { status: 302, headers });
    } else {
        return renderMessagePage("Error", `Failed to update balance for ${username}. User may not exist.`, true, adminBackLink);
    }
}

// UPDATED: Now takes formData
async function handleAddProduct(formData: FormData): Promise<Response> {
    const name = formData.get("name")?.toString();
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;
    const imageUrl = formData.get("imageUrl")?.toString();
    const token = formData.get("token")?.toString();
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!name || isNaN(price) || price <= 0 || !imageUrl) {
        return renderMessagePage("Error", "Missing name, price, or image URL.", true, adminBackLink);
    }
    
    await addProduct(name, price, imageUrl);
    
    // Redirect back to admin panel with success message
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=product_added`);
    return new Response("Redirecting...", { status: 302, headers });
}


function handleLogout(): Response {
    const headers = new Headers();
    headers.set("Location", "/login");
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=deleted; Path=/; Max-Age=0; HttpOnly`); 
    return new Response("Logged out. Redirecting...", { status: 302, headers });
}

// ----------------------------------------------------
// Main Server Router (FIXED for Admin POST)
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
        if (token !== ADMIN_TOKEN) return renderMessagePage("Error", "Unauthorized.", true);
        const message = url.searchParams.get("message");
        return renderAdminPanel(token, message); 
    }
    
    // --- Protected Routes (Must be logged in) ---
    const username = getUsernameFromCookie(req);

    if (pathname === "/buy" && req.method === "POST") {
        if (!username) return handleLogout();
        return handleBuy(req, username); // handleBuy reads formData
    }
    
    if (pathname === "/dashboard") {
        if (!username) return handleLogout();
        return handleDashboard(username);
    }
    
    if (pathname === "/user-info") {
        if (!username) return handleLogout();
        return handleUserInfoPage(username);
    }

    // --- Admin POST routes (Checked after user routes)
    // We check POST here to avoid reading formData() unless necessary
    if (req.method === "POST") {
        const formData = await req.formData(); // Read body ONCE
        const token = formData.get("token")?.toString();
        
        if (token !== ADMIN_TOKEN) {
            return renderMessagePage("Error", "Unauthorized: Invalid Token.", true);
        }

        if (pathname === "/admin/topup") {
            return handleAdminTopUp(formData);
        }
        
        if (pathname === "/admin/add_product") {
            return handleAddProduct(formData);
        }
    }

    // --- Default Route ---
    const headers = new Headers();
    headers.set("Location", "/login");
    return new Response("Redirecting to /login...", { status: 302, headers });
}

// Start the Deno Server
Deno.serve(handler);
