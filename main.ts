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
    itemName?: string; // Store the item name for purchases
}
interface Product {
    id: string; 
    name: string; 
    price: number; 
    imageUrl: string; 
}

// ----------------------------------------------------
// Core Helper Functions
// ----------------------------------------------------
function formatCurrency(amount: number): string {
    return amount.toLocaleString('en-US');
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
async function logTransaction(username: string, amount: number, type: "topup" | "purchase", itemName?: string): Promise<void> {
    const timestamp = new Date().toISOString(); 
    const key = ["transactions", username, timestamp]; 
    const transaction: Transaction = { type, amount, timestamp, itemName };
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
// --- Product KV Functions ---
async function getProducts(): Promise<Product[]> {
    const entries = kv.list<Product>({ prefix: ["products"] });
    const products: Product[] = [];
    for await (const entry of entries) {
        products.push(entry.value);
    }
    return products.sort((a, b) => parseInt(a.id) - parseInt(b.id)); 
}
async function getProductById(id: string): Promise<Product | null> {
    const key = ["products", id];
    const result = await kv.get<Product>(key);
    return result.value;
}
async function addProduct(name: string, price: number, imageUrl: string): Promise<boolean> {
    const id = Date.now().toString(); 
    const product: Product = { id, name, price, imageUrl };
    const key = ["products", id];
    const res = await kv.set(key, product);
    return res.ok;
}
async function updateProduct(id: string, name: string, price: number, imageUrl: string): Promise<boolean> {
    const key = ["products", id];
    const product: Product = { id, name, price, imageUrl };
    const res = await kv.set(key, product);
    return res.ok;
}
async function deleteProduct(id: string): Promise<void> {
    const key = ["products", id];
    await kv.delete(key);
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
// HTML Render Functions (Pages) - NEW UI
// ----------------------------------------------------
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

// NEW: Global styles for all pages (centers content)
const globalStyles = `
    body { 
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        margin: 0; padding: 20px; box-sizing: border-box; 
        background-color: #f0f2f5; 
        display: flex; justify-content: center; align-items: center; min-height: 100vh; 
    }
    .container { 
        max-width: 500px; width: 100%; 
        padding: 2.5rem; background-color: white; 
        border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.05); 
    }
    h1 { color: #1c1c1e; margin-top: 0; } 
    h2 { border-bottom: 1px solid #e5e5e7; padding-bottom: 10px; color: #333; }
    a { color: #007aff; text-decoration: none; }
    button { 
        background-color: #007aff; color: white; border: none; 
        padding: 12px 20px; border-radius: 8px; cursor: pointer; 
        font-weight: 600; width: 100%; font-size: 1rem;
    }
    .error { color: #ff3b30; background-color: #ffebe9; padding: 10px; border-radius: 5px; }
    .success { color: #34c759; background-color: #e6f7eb; padding: 10px; border-radius: 5px; }
    input[type="text"], input[type="password"], input[type="number"], input[type="url"] { 
        width: 95%; padding: 12px; margin-top: 8px; margin-bottom: 16px;
        border: 1px solid #c7c7cc; border-radius: 8px; font-size: 1rem; 
    }
    label { font-weight: 600; color: #333; }
`;

// Helper to render styled message pages (for auth failures)
function renderMessagePage(title: string, message: string, isError = false, backLink: string | null = null): Response {
    const borderColor = isError ? "#ff3b30" : "#34c759";
    const linkHref = backLink || "/dashboard";
    const linkText = backLink === null ? "Back to Shop" : "Go Back";

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>${globalStyles} .container{text-align:center; border-top:5px solid ${borderColor};} .message{font-size:1.2em; color:${isError ? '#ff3b30' : '#333'};}</style></head>
        <body><div class="container"><h1>${title}</h1><p class="message">${message}</p><br><a href="${linkHref}">${linkText}</a></div></body></html>`;
    
    return new Response(html, { status: isError ? 400 : 200, headers: HTML_HEADERS });
}

function renderLoginForm(req: Request): Response {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Login</title><style>${globalStyles}</style></head>
        <body><div class="container">
            <h1>Welcome Back!</h1>
            ${error === 'invalid' ? '<p class="error">Invalid username or password.</p>' : ''}
            <form action="/auth" method="POST">
                <label for="username">Name:</label><br>
                <input type="text" id="username" name="username" required><br><br>
                <label for="password">Password:</label><br>
                <input type="password" id="password" name="password" required><br><br>
                <button type="submit">Log In</button>
            </form>
            <p style="margin-top:20px; text-align:center;">Don't have an account? <a href="/register">Register Here</a></p>
        </div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

function renderRegisterForm(req: Request): Response {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Register</title><style>${globalStyles} button.register{background-color:#34c759;}</style></head>
        <body><div class="container"><h1>Create Account</h1>
        ${error === 'exists' ? '<p class="error">This username is already taken.</p>' : ''}
        <form action="/doregister" method="POST"><label for="username">Choose Name:</label><br><input type="text" id="username" name="username" required><br><br><label for="password">Choose Password:</label><br><input type="password" id="password" name="password" required><br><br><button type="submit" class="register">Create Account</button></form>
        <p style="margin-top:20px; text-align:center;">Already have an account? <a href="/login">Login</a></p></div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

async function renderAdminPanel(token: string, message: string | null): Promise<Response> {
    let messageHtml = "";
    if (message === "topup_success") messageHtml = `<div class="success">User balance updated!</div>`;
    if (message === "product_added") messageHtml = `<div class="success">Product added!</div>`;
    if (message === "product_updated") messageHtml = `<div class="success">Product updated!</div>`;
    if (message === "product_deleted") messageHtml = `<div class="error" style="background-color:#ffebe9;">Product deleted!</div>`;

    const products = await getProducts();
    const productListHtml = products.map(p => `
        <div class="product-item">
            <span>${p.name} (${formatCurrency(p.price)} Ks)</span>
            <div class="actions">
                <a href="/admin/edit_product?token=${token}&id=${p.id}" class="edit-btn">Edit</a>
                <form method="POST" action="/admin/delete_product" style="display:inline;" onsubmit="return confirm('Delete ${p.name}?');">
                    <input type="hidden" name="token" value="${token}"><input type="hidden" name="productId" value="${p.id}">
                    <button type="submit" class="delete-btn">Delete</button>
                </form>
            </div>
        </div>
    `).join('');

    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin Panel</title>
        <style>${globalStyles}
            button.admin{background-color:#34c759; width:100%;} button.product{background-color:#ff9500; color:white; width:100%;} hr{margin:30px 0; border:0; border-top:1px solid #e5e5e7;}
            .success { padding: 10px; background-color: #e6f7eb; color: #34c759; border-radius: 5px; margin-bottom: 15px; }
            .product-item { display:flex; justify-content:space-between; align-items:center; padding:10px; border-bottom:1px solid #eee; }
            .edit-btn { background-color:#007aff; color:white; padding:5px 10px; border-radius:4px; font-size: 0.9em; }
            .delete-btn { background-color:#ff3b30; padding:5px 10px; font-size: 0.9em; }
        </style></head>
        <body><div class="container">
            ${messageHtml}
            <h2>Product Management</h2><div class="product-list">${products.length > 0 ? productListHtml : '<p>No products yet.</p>'}</div><hr>
            <h2>Add New Product</h2>
            <form action="/admin/add_product" method="POST"><input type="hidden" name="token" value="${token}"><label>Product Name:</label><input type="text" name="name" required><br><br><label>Price (Ks):</label><input type="number" name="price" required><br><br><label>Image URL (or Emoji):</label><input type="url" name="imageUrl" required><br><br><button type="submit" class="product">Add Product</button></form><hr>
            <h2>User Top-Up</h2>
            <form action="/admin/topup" method="POST"><input type="hidden" name="token" value="${token}"><label>User Name:</label><input type="text" name="name" required><br><br><label>Amount (Ks):</label><input type="number" name="amount" required><br><br><button type="submit" class="admin">Add Balance</button></form>
        </div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

async function renderEditProductPage(token: string, product: Product): Promise<Response> {
    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Edit Product</title><style>${globalStyles} button.product{background-color:#ff9500; color:white; width:100%;}</style></head>
        <body><div class="container">
            <h1>Edit Product</h1>
            <form action="/admin/update_product" method="POST">
                <input type="hidden" name="token" value="${token}"><input type="hidden" name="productId" value="${product.id}">
                <label>Product Name:</label><input type="text" name="name" required value="${product.name}"><br><br>
                <label>Price (Ks):</label><input type="number" name="price" required value="${product.price}"><br><br>
                <label>Image URL (or Emoji):</label><input type="url" name="imageUrl" required value="${product.imageUrl}"><br><br>
                <button type="submit" class="product">Update Product</button>
            </form><p style="text-align:center; margin-top:20px;"><a href="/admin/panel?token=${token}">Cancel</a></p>
        </div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

// UPDATED: Dashboard now reads products from KV and formats numbers
async function handleDashboard(req: Request, username: string): Promise<Response> {
    const user = await getUserByUsername(username);
    if (!user) return handleLogout(); 
    
    // NEW: Check for success/error messages from URL
    const url = new URL(req.url);
    const message = url.searchParams.get("message");
    let messageHtml = "";
    if (message === "buy_success") {
        messageHtml = `<div class="alert success">Purchase successful! Your balance has been updated.</div>`;
    }
    if (message === "buy_fail") {
        messageHtml = `<div class="alert error">Purchase failed: Insufficient funds. Please contact admin.</div>`;
    }

    const products = await getProducts();
    
    const productListHtml = products.map(product => `
        <div class="item-card">
            <div class="item-info">
                <h3>${product.imageUrl.startsWith('http') ? `<img src="${product.imageUrl}" alt="${product.name}" height="40" style="vertical-align:middle; margin-right:10px; border-radius: 5px;">` : product.imageUrl} ${product.name} 
                    <span class="price">(${formatCurrency(product.price)} Ks)</span>
                </h3>
            </div>
            <form method="POST" action="/buy" onsubmit="return checkBalance('${product.name}', ${product.price}, ${user.balance});">
                <input type="hidden" name="item" value="${product.name}"><input type="hidden" name="price" value="${product.price}">
                <button type="submit" class="buy-btn">Buy Now</button>
            </form>
        </div>
    `).join('');
    
    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shop Dashboard</title>
        <style>${globalStyles}
            .balance-box{background-color:#e6f7ff; padding:15px 20px; border-radius:8px; margin-bottom:20px; border: 1px solid #bce6ff;} 
            .balance-amount{font-size:2.2em; color:#007aff; font-weight:bold;} 
            .item-card{border:1px solid #e5e5e7; padding:15px; margin-bottom:15px; border-radius:8px; display:flex; justify-content:space-between; align-items:center;} 
            .item-info h3{margin-top:0; margin-bottom:0; color:#333; font-size:1.1em; display:flex; align-items:center;} 
            .price{font-weight:bold; color:#555; margin-left:10px;} 
            .buy-btn{background-color:#34c759; color:white; border:none; padding:10px 15px; border-radius:8px; cursor:pointer; font-weight:600;} 
            .nav-links{display:flex; justify-content:space-between; margin-top:30px;}
            .alert { padding: 15px; margin-bottom: 20px; border-radius: 8px; font-weight: 600; }
            .alert.success { background-color: #e6f7eb; color: #34c759; border: 1px solid #c3e6cb; }
            .alert.error { background-color: #ffebe9; color: #ff3b30; border: 1px solid #ffcdd2; }
        </style>
        </head>
        <body><div class="container">
            ${messageHtml}
            <h1>Welcome, ${user.username}!</h1>
            <div class="balance-box"><span>Current Balance:</span><div class="balance-amount">${formatCurrency(user.balance)} Ks</div></div>
            <h2>🛒 Shop Items:</h2>
            ${products.length > 0 ? productListHtml : '<p>No products available yet. Check back soon!</p>'}
            <div class="nav-links"><a href="/user-info">My Info</a><a href="/logout" style="color:#ff3b30;">Logout</a></div>
        </div>
        <script>
            function checkBalance(itemName, price, balance) {
                if (balance < price) {
                    alert("Insufficient Balance!\\nYou have " + formatCurrency(balance) + " Ks but need " + formatCurrency(price) + " Ks.\\nPlease contact admin for a top-up.");
                    return false; 
                }
                return confirm("Are you sure you want to buy " + itemName + " for " + formatCurrency(price) + " Ks?");
            }
            function formatCurrency(amount) {
                return amount.toLocaleString('en-US');
            }
        </script>
        </body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

// ROUTE: /user-info (UPDATED with Timezone + Formatting + UI)
async function handleUserInfoPage(username: string): Promise<Response> {
    const user = await getUserByUsername(username);
    if (!user) return handleLogout();

    const transactions = await getTransactions(username);
    
    function toMyanmarTime(utcString: string): string {
        try { return new Date(utcString).toLocaleString("en-US", { timeZone: MYANMAR_TIMEZONE, hour12: true }); } 
        catch (e) { return utcString; }
    }

    const topUpHistory = transactions.filter(t => t.type === 'topup')
        .map(t => `<li>On ${toMyanmarTime(t.timestamp)}, you received <strong>${formatCurrency(t.amount)} Ks</strong>.</li>`).join('');
    
    const purchaseHistory = transactions.filter(t => t.type === 'purchase')
        .map(t => `<li>On ${toMyanmarTime(t.timestamp)}, you bought <strong>${t.itemName || 'an item'}</strong> for <strong>${formatCurrency(Math.abs(t.amount))} Ks</strong>.</li>`).join('');

    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My Info</title>
        <style>${globalStyles} 
            .info-item{font-size:1.2em; margin-bottom:10px; padding: 10px; background-color: #f8f8f8; border-radius: 5px;} 
            .history{margin-top:20px;} 
            ul{padding-left: 20px; list-style-type: none; margin: 0; padding: 0;}
            li { background-color: #f8f8f8; padding: 10px; border-radius: 5px; margin-bottom: 8px; }
        </style></head>
        <body><div class="container"><h1>My User Info</h1>
        <div class="info-item"><strong>Username:</strong> ${user.username}</div>
        <div class="info-item"><strong>Balance:</strong> ${formatCurrency(user.balance)} Ks</div>
        <p style="font-size:0.9em; color:gray;">(For security, passwords are never shown.)</p>
        <div class="history"><h2>Top-Up History</h2>${topUpHistory.length > 0 ? `<ul>${topUpHistory}</ul>` : '<p>You have not received any top-ups yet.</p>'}</div>
        <div class="history"><h2>Purchase History</h2>${purchaseHistory.length > 0 ? `<ul>${purchaseHistory}</ul>` : '<p>You have not made any purchases yet.</p>'}</div>
        <a href="/dashboard" style="display:inline-block; margin-top:20px;">Back to Shop</a></div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}


// ----------------------------------------------------
// Action Handlers (Processing POST requests)
// ----------------------------------------------------

async function handleAuth(req: Request): Promise<Response> {
    const formData = await req.formData();
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();

    if (!username || !password) return renderLoginForm(req); // Show login form with error
    const user = await getUserByUsername(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
         const headers = new Headers();
         headers.set("Location", "/login?error=invalid");
         return new Response("Redirecting...", { status: 302, headers });
    }
    
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

// UPDATED: handleBuy now redirects back to dashboard with a message
async function handleBuy(req: Request, username: string): Promise<Response> {
    const formData = await req.formData();
    const item = formData.get("item")?.toString();
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;

    if (!item || isNaN(price) || price <= 0) {
        const headers = new Headers();
        headers.set("Location", "/dashboard?message=buy_fail");
        return new Response("Redirecting...", { status: 302, headers });
    }

    // Server-side balance check (final security)
    const success = await updateUserBalance(username, -price); 

    const headers = new Headers();
    if (success) {
        await logTransaction(username, -price, "purchase", item); // Pass item name
        headers.set("Location", "/dashboard?message=buy_success");
    } else {
        headers.set("Location", "/dashboard?message=buy_fail");
    }
    return new Response("Redirecting...", { status: 302, headers });
}

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
        const headers = new Headers();
        headers.set("Location", `/admin/panel?token=${token}&message=topup_success`);
        return new Response("Redirecting...", { status: 302, headers });
    } else {
        return renderMessagePage("Error", `Failed to update balance for ${username}. User may not exist.`, true, adminBackLink);
    }
}

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
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=product_added`);
    return new Response("Redirecting...", { status: 302, headers });
}

async function handleUpdateProduct(formData: FormData): Promise<Response> {
    const productId = formData.get("productId")?.toString();
    const name = formData.get("name")?.toString();
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;
    const imageUrl = formData.get("imageUrl")?.toString();
    const token = formData.get("token")?.toString();
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!productId || !name || isNaN(price) || price <= 0 || !imageUrl) {
        return renderMessagePage("Error", "Missing data for update.", true, adminBackLink);
    }
    
    await updateProduct(productId, name, price, imageUrl);
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=product_updated`);
    return new Response("Redirecting...", { status: 302, headers });
}

async function handleDeleteProduct(formData: FormData): Promise<Response> {
    const productId = formData.get("productId")?.toString();
    const token = formData.get("token")?.toString();
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!productId) {
        return renderMessagePage("Error", "Missing product ID.", true, adminBackLink);
    }
    
    await deleteProduct(productId);
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=product_deleted`);
    return new Response("Redirecting...", { status: 302, headers });
}


function handleLogout(): Response {
    const headers = new Headers();
    headers.set("Location", "/login");
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=deleted; Path=/; Max-Age=0; HttpOnly`); 
    return new Response("Logged out. Redirecting...", { status: 302, headers });
}

// ----------------------------------------------------
// Main Server Router (FINALIZED)
// ----------------------------------------------------

async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    
    // --- Public GET Routes ---
    if (req.method === "GET") {
        if (pathname === "/login") return renderLoginForm(req);
        if (pathname === "/register") return renderRegisterForm(req);
        if (pathname === "/logout") return handleLogout();

        // --- Admin GET Routes ---
        const token = url.searchParams.get("token");
        if (pathname === "/admin/panel") {
            if (token !== ADMIN_TOKEN) return renderMessagePage("Error", "Unauthorized.", true);
            const message = url.searchParams.get("message");
            return await renderAdminPanel(token, message); 
        }
        if (pathname === "/admin/edit_product") {
            if (token !== ADMIN_TOKEN) return renderMessagePage("Error", "Unauthorized.", true);
            const productId = url.searchParams.get("id");
            if (!productId) return renderMessagePage("Error", "Missing product ID.", true, `/admin/panel?token=${token}`);
            const product = await getProductById(productId);
            if (!product) return renderMessagePage("Error", "Product not found.", true, `/admin/panel?token=${token}`);
            return await renderEditProductPage(token, product);
        }

        // --- Protected User GET Routes ---
        const username = getUsernameFromCookie(req);
        if (pathname === "/dashboard") {
            if (!username) return handleLogout();
            return await handleDashboard(req, username); // Pass req to read URL messages
        }
        if (pathname === "/user-info") {
            if (!username) return handleLogout();
            return await handleUserInfoPage(username);
        }
    }
    
    // --- POST Routes ---
    if (req.method === "POST") {
        // User POST (does not need token)
        if (pathname === "/auth") return handleAuth(req);
        if (pathname === "/doregister") return handleRegister(req);
        
        // --- User 'Buy' POST (needs session) ---
        if (pathname === "/buy") {
            const username = getUsernameFromCookie(req);
            if (!username) return handleLogout();
            return handleBuy(req, username); 
        }

        // --- Admin POST (requires token) ---
        const formData = await req.formData();
        const token = formData.get("token")?.toString();
        if (token !== ADMIN_TOKEN) {
            return renderMessagePage("Error", "Unauthorized: Invalid Token.", true);
        }

        if (pathname === "/admin/topup") return handleAdminTopUp(formData);
        if (pathname === "/admin/add_product") return handleAddProduct(formData);
        if (pathname === "/admin/update_product") return handleUpdateProduct(formData);
        if (pathname === "/admin/delete_product") return handleDeleteProduct(formData);
    }

    // --- Default Route (Redirect all other requests to login) ---
    const headers = new Headers();
    headers.set("Location", "/login");
    return new Response("Redirecting to /login...", { status: 302, headers });
}

// Start the Deno Server
Deno.serve(handler);
