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
    isBlocked?: boolean; 
}
interface Transaction {
    type: "topup" | "purchase";
    amount: number;
    timestamp: string; 
    itemName?: string; 
    itemDetails?: string; 
}
// NEW: For admin sales history
interface DigitalSaleLog {
    username: string;
    itemName?: string;
    itemDetails?: string;
    timestamp: string;
    amount: number;
}
interface Product {
    id: string; 
    name: string; 
    price: number; 
    salePrice?: number | null;
    imageUrl: string; 
    isDigital: boolean; 
    stock: string[]; 
}
interface Voucher {
    code: string; 
    value: number; 
    isUsed: boolean; 
    generatedAt: string;
}
interface Announcement {
    message: string;
}

// ----------------------------------------------------
// Core Helper Functions
// ----------------------------------------------------

function formatCurrency(amount: number): string {
    return amount.toLocaleString('en-US');
}

function toMyanmarTime(utcString: string): string {
    try { return new Date(utcString).toLocaleString("en-US", { timeZone: MYANMAR_TIMEZONE, hour12: true }); } 
    catch (e) { return utcString; }
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
    const user: User = { 
        username, 
        passwordHash, 
        balance: 0, 
        isBlocked: false 
    };
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

async function resetUserPassword(username: string, newPasswordHash: string): Promise<boolean> {
    const key = ["users", username];
    const result = await kv.get<User>(key);
    const user = result.value;
    if (!user) return false; 
    user.passwordHash = newPasswordHash;
    const res = await kv.atomic().check(result).set(key, user).commit();
    return res.ok;
}

async function toggleBlockUser(username: string): Promise<string> {
    const key = ["users", username];
    const result = await kv.get<User>(key);
    const user = result.value;
    if (!user) return "User not found.";
    const newStatus = !user.isBlocked;
    user.isBlocked = newStatus;
    const res = await kv.atomic().check(result).set(key, user).commit();
    if (res.ok) {
        return newStatus ? `User '${username}' has been BLOCKED.` : `User '${username}' has been UNBLOCKED.`;
    }
    return "Failed to update user status.";
}


async function transferBalance(senderUsername: string, recipientUsername: string, amount: number): Promise<string> {
    if (senderUsername === recipientUsername) return "Cannot send money to yourself.";
    if (amount <= 0) return "Amount must be positive.";
    
    const senderKey = ["users", senderUsername];
    const recipientKey = ["users", recipientUsername];

    while (true) {
        const [senderResult, recipientResult] = await kv.getMany<[User, User]>([senderKey, recipientKey]);

        if (!senderResult.value) return "Sender not found.";
        if (!recipientResult.value) return "Recipient user not found.";

        const sender = senderResult.value;
        const recipient = recipientResult.value;

        if (sender.isBlocked) return "Your account is suspended.";
        if (recipient.isBlocked) return "Recipient account is suspended.";

        if (sender.balance < amount) {
            return `Insufficient balance. You only have ${formatCurrency(sender.balance)} Ks.`;
        }

        const newSenderBalance = sender.balance - amount;
        const newRecipientBalance = recipient.balance + amount;
        
        const res = await kv.atomic()
            .check(senderResult).check(recipientResult) 
            .set(senderKey, { ...sender, balance: newSenderBalance })
            .set(recipientKey, { ...recipient, balance: newRecipientBalance })
            .commit();
        
        if (res.ok) {
            await logTransaction(senderUsername, -amount, "purchase", `Transfer to ${recipientUsername}`);
            await logTransaction(recipientUsername, amount, "topup", `Transfer from ${senderUsername}`);
            return "success"; 
        }
    }
}


async function logTransaction(username: string, amount: number, type: "topup" | "purchase", itemName?: string, itemDetails?: string): Promise<void> {
    const timestamp = new Date().toISOString(); 
    const key = ["transactions", username, timestamp]; 
    const transaction: Transaction = { type, amount, timestamp, itemName, itemDetails }; 
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

// NEW: Function to get all digital sales for Admin
async function getDigitalSalesHistory(): Promise<DigitalSaleLog[]> {
    const entries = kv.list<Transaction>({ prefix: ["transactions"] });
    const logs: DigitalSaleLog[] = [];
    for await (const entry of entries) {
        const t = entry.value;
        if (t.type === 'purchase' && t.itemDetails) {
            logs.push({
                username: entry.key[1] as string, // Get username from key
                itemName: t.itemName,
                itemDetails: t.itemDetails,
                timestamp: t.timestamp,
                amount: t.amount
            });
        }
    }
    return logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()); // Sort by most recent
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

async function getProductById(id: string): Promise<{value: Product, versionstamp: string} | null> {
    const key = ["products", id];
    const result = await kv.get<{value: Product, versionstamp: string}>(key);
    if (!result.value) return null;
    return result;
}

async function addProduct(name: string, price: number, salePrice: number | null, imageUrl: string, isDigital: boolean, stock: string[]): Promise<boolean> {
    const id = Date.now().toString(); 
    const product: Product = { id, name, price, salePrice, imageUrl, isDigital, stock: stock || [] };
    const key = ["products", id];
    const res = await kv.set(key, product);
    return res.ok;
}

async function updateProduct(id: string, name: string, price: number, salePrice: number | null, imageUrl: string, isDigital: boolean, stock: string[]): Promise<boolean> {
    const key = ["products", id];
    const product: Product = { id, name, price, salePrice, imageUrl, isDigital, stock: stock || [] };
    const res = await kv.set(key, product);
    return res.ok;
}

async function deleteProduct(id: string): Promise<void> {
    const key = ["products", id];
    await kv.delete(key);
}

// --- Voucher KV Functions ---
async function generateVoucher(value: number): Promise<Voucher> {
    const code = `SHOP-${Date.now().toString().slice(-6)}`; 
    const voucher: Voucher = { code, value, isUsed: false, generatedAt: new Date().toISOString() };
    const key = ["vouchers", code];
    await kv.set(key, voucher);
    return voucher;
}

async function getVoucherByCode(code: string): Promise<{value: Voucher, versionstamp: string} | null> {
    const key = ["vouchers", code.toUpperCase()]; 
    const result = await kv.get<{value: Voucher, versionstamp: string}>(key);
    if (!result.value) return null;
    return result;
}

async function getUnusedVouchers(): Promise<Voucher[]> {
    const entries = kv.list<Voucher>({ prefix: ["vouchers"] });
    const vouchers: Voucher[] = [];
    for await (const entry of entries) {
        if (!entry.value.isUsed) {
            vouchers.push(entry.value);
        }
    }
    return vouchers.sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime());
}

// --- Announcement KV Functions ---
async function getAnnouncement(): Promise<string | null> {
    const key = ["site_announcement"];
    const result = await kv.get<Announcement>(key);
    return result.value ? result.value.message : null;
}

async function setAnnouncement(message: string): Promise<void> {
    const key = ["site_announcement"];
    if (message.trim() === "") {
        await kv.delete(key); 
    } else {
        await kv.set(key, { message });
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
    if (!cookieHeader || !cookieHeader.includes(SESSION_COOKIE_NAME)) return null;
    try {
        const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
        return match ? decodeURIComponent(match[1].split(';')[0]) : null;
    } catch (e) {
        console.error("Cookie decode error:", e);
        return null;
    }
}

function createSession(username: string, remember: boolean): Headers {
    const headers = new Headers();
    const encodedSessionId = encodeURIComponent(username); 
    const maxAge = remember ? 2592000 : 3600; // 30 days or 1 hour
    headers.set("Location", "/dashboard");
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=${encodedSessionId}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
    return headers;
}

// ----------------------------------------------------
// HTML Render Functions (Pages)
// ----------------------------------------------------

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

const globalStyles = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; margin: 0; padding: 20px; background-color: #f0f2f5; display: flex; justify-content: center; align-items: center; min-height: 90vh; }
    .container { max-width: 500px; width: 100%; padding: 30px; background-color: #ffffff; border-radius: 12px; box-shadow: 0 6px 16px rgba(0,0,0,0.1); }
    h1 { color: #1c1e21; font-weight: 600; margin-bottom: 20px; text-align: center; } 
    h2 { border-bottom: 1px solid #eee; padding-bottom: 5px; color: #333; }
    a { color: #007bff; text-decoration: none; }
    button { background-color: #007bff; color: white; border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-size: 16px; font-weight: 600; width: 100%; }
    .error { color: #dc3545; background-color: #f8d7da; padding: 10px; border-radius: 5px; margin-bottom: 15px; }
    .success-msg { padding: 10px; background-color: #d4edda; color: #155724; border-radius: 5px; margin-bottom: 15px; }
    input[type="text"], input[type="password"], input[type="number"], input[type="url"], textarea { 
        width: 95%; padding: 12px 10px; margin-top: 5px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; 
    }
    label { font-weight: 600; color: #555; }
    .checkbox-container { display: flex; align-items: center; margin-top: 15px; }
    .checkbox-container input { width: auto; margin-right: 10px; }
`;

function renderLoginForm(req: Request): Response {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    
    let errorHtml = "";
    if (error === 'invalid') errorHtml = '<p class="error">Invalid username or password. Please try again.</p>';
    if (error === 'missing') errorHtml = '<p class="error">Please enter both username and password.</p>';
    if (error === 'blocked') errorHtml = '<p class="error">Your account has been suspended by the admin.</p>';

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Login</title>
        <style>${globalStyles}
            .login-icon { text-align: center; margin-bottom: 15px; }
            .login-icon svg { width: 50px; height: 50px; color: #007bff; }
        </style></head>
        <body><div class="container">
        <div class="login-icon">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h2.64m-2.64 0l1.1-1.291c.414-.414.414-1.083 0-1.497l-1.1-1.291M18 21v-3.328c0-.68.27-1.306.73-1.767l1.1-1.291M18 21v-7.5a.75.75 0 0 0-.75-.75h-3a.75.75 0 0 0-.75.75V21m-4.5 0H2.36m11.14 0H18m0 0h2.64m-2.64 0l1.1-1.291c.414-.414.414-1.083 0-1.497l-1.1-1.291M18 21v-3.328c0-.68.27-1.306.73-1.767l1.1-1.291m0 0l-1.1 1.291m1.1-1.291L19.1 16.24c.414-.414.414-1.083 0-1.497l-1.1-1.291M2.36 21c.62 0 1.18-.034 1.71-.1H2.36m13.32 0a1.14 1.14 0 0 0 1.71-.1h-1.71M2.36 21c.62 0 1.18-.034 1.71-.1H2.36m13.32 0a1.14 1.14 0 0 0 1.71-.1h-1.71M2.36 21c.62 0 1.18-.034 1.71-.1H2.36m9.84-9.924c.414-.414.414-1.083 0-1.497l-1.1-1.291c-.414-.414-1.083-.414-1.497 0l-1.1 1.291c-.414.414-.414 1.083 0 1.497l1.1 1.291c.414.414 1.083.414 1.497 0l1.1-1.291M4.07 20.9c.62.066 1.18.1 1.71.1H4.07m9.84-9.924c.414-.414.414-1.083 0-1.497l-1.1-1.291c-.414-.414-1.083-.414-1.497 0l-1.1 1.291c-.414.414-.414 1.083 0 1.497l1.1 1.291c.414.414 1.083.414 1.497 0l1.1-1.291M4.07 20.9c.62.066 1.18.1 1.71.1H4.07m9.84-9.924c.414-.414.414-1.083 0-1.497l-1.1-1.291c-.414-.414-1.083-.414-1.497 0l-1.1 1.291c-.414.414-.414 1.083 0 1.497l1.1 1.291c.414.414 1.083.414 1.497 0l1.1-1.291M4.07 20.9v-3.328c0-.68.27-1.306.73-1.767l1.1-1.291c.414-.414.414-1.083 0-1.497l-1.1-1.291c-.414-.414-1.083-.414-1.497 0l-1.1 1.291c-.414.414-.414 1.083 0 1.497l1.1 1.291c.414.414 1.083.414 1.497 0l1.1-1.291m0 0l-1.1 1.291m1.1-1.291L5.17 16.24c.414-.414.414-1.083 0-1.497l-1.1-1.291m0 0L2.97 12.16c-.414-.414-.414-1.083 0-1.497l1.1-1.291m0 0L2.97 7.875c-.414-.414-.414-1.083 0-1.497L4.07 5.09c.414-.414 1.083-.414 1.497 0l1.1 1.291c.414.414.414 1.083 0 1.497L5.567 9.17c-.414.414-1.083.414-1.497 0L2.97 7.875m1.1 1.291L5.17 7.875m0 0L4.07 6.583c-.414-.414-1.083-.414-1.497 0L1.473 7.875c-.414.414-.414 1.083 0 1.497l1.1 1.291c.414.414 1.083.414 1.497 0l1.1-1.291" />
            </svg>
        </div>
        <h1>User Login</h1>${errorHtml} 
        <form action="/auth" method="POST">
        <label for="username">Name:</label><br><input type="text" id="username" name="username" required><br><br>
        <label for="password">Password:</label><br><input type="password" id="password" name="password" required><br>
        <div class="checkbox-container"><input type="checkbox" id="remember" name="remember"><label for="remember">Remember Me</label></div><br>
        <button type="submit">Log In</button></form>
        <p style="margin-top:20px; text-align:center;">Don't have an account? <a href="/register">Register Here</a></p></div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

function renderRegisterForm(req: Request): Response {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Register</title>
        <style>${globalStyles} 
            button.register{background-color:#28a745;}
            .login-icon { text-align: center; margin-bottom: 15px; }
            .login-icon svg { width: 50px; height: 50px; color: #28a745; }
        </style></head>
        <body><div class="container">
        <div class="login-icon">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0ZM3 19.235v-.11a6.375 6.375 0 0 1 12.75 0v.109A12.318 12.318 0 0 1 9.374 21c-2.331 0-4.512-.645-6.374-1.766Z" />
            </svg>
        </div>
        <h1>Create Account</h1>
        ${error === 'exists' ? '<p class="error">This username is already taken.</p>' : ''}
        <form action="/doregister" method="POST">
            <label for="username">Choose Name:</label><br><input type="text" id="username" name="username" required><br><br>
            <label for="password">Choose Password:</label><br><input type="password" id="password" name="password" required><br>
            <div class="checkbox-container"><input type="checkbox" id="remember" name="remember" checked><label for="remember">Remember Me</label></div><br>
            <button type="submit" class="register">Create Account</button></form>
        <p style="margin-top:20px; text-align:center;">Already have an account? <a href="/login">Login</a></p></div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

// UPDATED: Admin Panel now includes Digital Sales History
async function renderAdminPanel(token: string, message: string | null): Promise<Response> {
    let messageHtml = "";
    if (message) messageHtml = `<div class="success-msg">${decodeURIComponent(message)}</div>`;

    const products = await getProducts();
    const productListHtml = products.map(p => `
        <div class="product-item">
            <span>${p.name} ${p.isDigital ? `<strong>(${p.stock.length} left)</strong>` : ''} ${p.salePrice ? `<strong style="color:red;">(Sale)</strong>` : ''}</span>
            <div class"actions">
                <a href="/admin/edit_product?token=${token}&id=${p.id}" class="edit-btn">Edit</a>
                <form method="POST" action="/admin/delete_product" style="display:inline;" onsubmit="return confirm('Delete ${p.name}?');">
                    <input type="hidden" name="token" value="${token}"><input type="hidden" name="productId" value="${p.id}"><button type="submit" class="delete-btn">Delete</button>
                </form>
            </div>
        </div>
    `).join('');

    const vouchers = await getUnusedVouchers();
    const voucherListHtml = vouchers.map(v => `
        <div class="voucher-item">
            <code class="voucher-code">${v.code}</code>
            <span class="voucher-value">${formatCurrency(v.value)} Ks</span>
        </div>
    `).join('');
    
    const currentAnnouncement = await getAnnouncement() || "";
    
    // NEW: Get Sales History
    const salesHistory = await getDigitalSalesHistory();
    const salesHistoryHtml = salesHistory.map(s => `
        <div class="voucher-item">
            <span><strong>${s.username}</strong> bought <strong>${s.itemName}</strong></span>
            <span class="voucher-value">${toMyanmarTime(s.timestamp)}</span>
        </div>
    `).join('');


    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Admin Panel</title>
        <style>${globalStyles}
            button.admin{background-color:#28a745;} button.product{background-color:#ffc107; color:black;} button.reset{background-color:#dc3545;} button.voucher{background-color:#17a2b8;}
            button.announcement{background-color:#6610f2;}
            hr{margin:30px 0; border:0; border-top:1px solid #eee;}
            .product-item, .voucher-item { display:flex; justify-content:space-between; align-items:center; padding:10px; border-bottom:1px solid #eee; }
            .edit-btn { background-color:#007bff; color:white; padding:5px 10px; border-radius:4px; font-size: 14px; }
            .delete-btn { background-color:#dc3545; padding:5px 10px; font-size: 14px; }
            .voucher-code { font-weight: bold; background: #eee; padding: 3px 6px; border-radius: 4px; }
            .history-list { max-height: 300px; overflow-y: auto; background-color: #fcfcfc; border: 1px solid #eee; padding: 10px; border-radius: 8px; }
        </style></head>
        <body><div class="container" style="max-width: 700px;">
            ${messageHtml}
            <h2>Site Announcement (Marquee)</h2>
            <form action="/admin/set_announcement" method="POST"><input type="hidden" name="token" value="${token}"><label>Message (leave empty to remove):</label><input type="text" name="message" value="${currentAnnouncement}"><br><br><button type="submit" class="announcement">Set Announcement</button></form><hr>

            <h2>Generate Voucher Code</h2>
            <form action="/admin/create_voucher" method="POST"><input type="hidden" name="token" value="${token}"><label>Voucher Value (Ks):</label><input type="number" name="amount" required><br><br><button type="submit" class="voucher">Generate Code</button></form>
            <div class="voucher-list"><h3>Unused Vouchers:</h3>${vouchers.length > 0 ? voucherListHtml : '<p>No unused vouchers.</p>'}</div><hr>
            
            <h2>Product Management</h2><div class="product-list">${products.length > 0 ? productListHtml : '<p>No products yet.</p>'}</div><hr>
            <h2>Add New Product</h2>
            <form action="/admin/add_product" method="POST">
                <input type="hidden" name="token" value="${token}">
                <label>Product Name:</label><input type="text" name="name" required><br><br>
                <label>Image URL (or Emoji):</label><input type="url" name="imageUrl" required><br><br>
                <label>Full Price (Ks):</label><input type="number" name="price" required><br><br>
                <label>Sale Price (Ks) (Optional):</label><input type="number" name="sale_price" placeholder="Leave empty for no sale"><br><br>
                <div class="checkbox-container"><input type="checkbox" id="isDigital" name="isDigital" onchange="document.getElementById('stock-details').style.display = this.checked ? 'block' : 'none';">
                    <label for="isDigital">Is this a Digital Code/Account?</label></div><br>
                <div id="stock-details" style="display:none;">
                    <label>Stock Details (One item per line):</label>
                    <textarea name="stock" rows="5" style="width: 95%;"></textarea>
                </div>
                <button type="submit" class="product">Add Product</button></form><hr>
            
            <h2>User Management</h2>
            <form action="/admin/adjust_balance" method="POST">
                <input type="hidden" name="token" value="${token}">
                <label>User Name (for Adjust Balance):</label><input type="text" name="name" required><br><br>
                <label>Amount (Ks):</label><input type="number" name="amount" required placeholder="e.g., 5000 or -500"><br><br>
                <button type="submit" class="admin">Adjust Balance</button>
            </form><br>
            <form action="/admin/reset_password" method="POST"><input type="hidden" name="token" value="${token}"><label>User Name (for Reset):</label><input type="text" name="name" required><br><br><label>New Password:</label><input type="text" name="new_password" required><br><br><button type="submit" class="reset">Reset Password</button></form><br>
            <form action="/admin/toggle_block" method="POST"><input type="hidden" name="token" value="${token}"><label>User Name (to Block/Unblock):</label><input type="text" name="name" required><br><br><button type="submit" style="background-color:#555;">Toggle Block Status</button></form><hr>

            <h2>Digital Sales History</h2>
            <div class="history-list">
                ${salesHistoryHtml.length > 0 ? salesHistoryHtml : '<p>No digital items sold yet.</p>'}
            </div>
        </div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

async function renderEditProductPage(token: string, product: Product): Promise<Response> {
    const stockString = product.stock ? product.stock.join('\n') : '';

    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Edit Product</title><style>${globalStyles} button.product{background-color:#ffc107; color:black;}</style></head>
        <body><div class="container">
            <h1>Edit Product</h1>
            <form action="/admin/update_product" method="POST">
                <input type="hidden" name="token" value="${token}"><input type="hidden" name="productId" value="${product.id}">
                <label>Product Name:</label><input type="text" name="name" required value="${product.name}"><br><br>
                <label>Image URL (or Emoji):</label><input type="url" name="imageUrl" required value="${product.imageUrl}"><br><br>
                <label>Full Price (Ks):</label><input type="number" name="price" required value="${product.price}"><br><br>
                <label>Sale Price (Ks) (Optional):</label><input type="number" name="sale_price" value="${product.salePrice || ''}" placeholder="Leave empty for no sale"><br><br>
                <div class="checkbox-container"><input type="checkbox" id="isDigital" name="isDigital" ${product.isDigital ? 'checked' : ''} onchange="document.getElementById('stock-details').style.display = this.checked ? 'block' : 'none';">
                    <label for="isDigital">Is this a Digital Code/Account?</label></div><br>
                <div id="stock-details" style="display:${product.isDigital ? 'block' : 'none'};">
                    <label>Stock Details (One item per line):</label>
                    <textarea name="stock" rows="5" style="width: 95%;">${stockString}</textarea>
                </div>
                <button type="submit" class="product">Update Product</button>
            </form><p style="text-align:center; margin-top:15px;"><a href="/admin/panel?token=${token}">Cancel</a></p>
        </div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

function renderMessagePage(title: string, message: string, isError = false, backLink: string | null = null): Response {
    const borderColor = isError ? "#dc3545" : "#28a745";
    const linkHref = backLink || "/dashboard";
    const linkText = backLink === null ? "Back to Shop" : "Go Back";
    const metaRefresh = isError ? '' : `<meta http-equiv="refresh" content="3;url=${linkHref}">`; 

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>${metaRefresh}<meta name="viewport" content="width=device-width, initial-scale=1"><style>${globalStyles} .container{text-align:center; border-top:5px solid ${borderColor};} .message{font-size:1.2em; color:${isError ? '#dc3545' : '#333'};}</style></head>
        <body><div class="container"><h1>${title}</h1><p class="message">${message}</p><br>${isError ? `<a href="${linkHref}">${linkText}</a>` : `<p style='color:#777; font-size:0.9em;'>Redirecting back automatically...</p>`}</div></body></html>`;
    
    return new Response(html, { status: isError ? 400 : 200, headers: HTML_HEADERS });
}

async function handleDashboard(user: User): Promise<Response> {
    const products = await getProducts();
    const announcement = await getAnnouncement(); 
    
    const announcementHtml = announcement ? `
        <div class="marquee-container">
            <div class="marquee-text">📢 ${announcement}</div>
        </div>
    ` : '';

    const productListHtml = products.map(product => {
        const hasSale = product.salePrice && product.salePrice > 0;
        const displayPrice = hasSale ? product.salePrice : product.price;
        const isOutOfStock = product.isDigital && (!product.stock || product.stock.length === 0);

        const priceHtml = hasSale
            ? `<div class="product-price sale">
                 <del>${formatCurrency(product.price)} Ks</del> <strong>${formatCurrency(displayPrice)} Ks</strong>
               </div>`
            : `<div class="product-price">${formatCurrency(product.price)} Ks</div>`;
            
        return `
        <div class="product-card ${isOutOfStock ? 'out-of-stock' : ''}">
            ${product.imageUrl.startsWith('http') ? `<img src="${product.imageUrl}" alt="${product.name}" class="product-image">` : `<div class="product-emoji">${product.imageUrl}</div>`}
            <h3 class="product-name">${product.name}</h3>
            ${priceHtml}
            <form method="POST" action="/buy" onsubmit="${isOutOfStock ? 'alert(\'This item is out of stock!\'); return false;' : `return checkBalance('${product.name}', ${displayPrice}, ${user.balance});`}">
                <input type="hidden" name="productId" value="${product.id}">
                <button type="submit" class="buy-btn" ${isOutOfStock ? 'disabled' : ''}>${isOutOfStock ? 'Out of Stock' : 'Buy Now'}</button>
            </form>
        </div>
    `}).join('');
    
    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shop</title>
        <style>${globalStyles}
            .nav-links { display: flex; justify-content: space-between; margin-bottom: 20px; margin-top: -10px; gap: 10px; }
            .nav-links a { display: block; padding: 10px 15px; border-radius: 8px; text-align: center; font-weight: 600; text-decoration: none; }
            .info-btn { background-color: #007bff; color: white; border: 1px solid #007bff; }
            .logout-btn { background-color: #ffffff; color: #007bff; border: 1px solid #007bff; }
            .balance-box { background: linear-gradient(90deg, #007bff, #0056b3); color: white; padding: 20px; border-radius: 12px; margin-bottom: 25px; text-align: center; }
            .balance-label { font-size: 16px; opacity: 0.9; }
            .balance-amount { font-size: 2.5em; font-weight: 700; letter-spacing: 1px; }
            .product-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 15px; }
            .product-card { background: #fff; border: 1px solid #ddd; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); text-align: center; padding: 15px; }
            .product-image { width: 100%; height: 100px; object-fit: cover; border-radius: 8px; }
            .product-emoji { font-size: 60px; line-height: 100px; height: 100px; }
            .product-name { font-size: 16px; font-weight: 600; color: #333; margin: 10px 0; }
            .product-price { font-size: 14px; font-weight: 600; color: #28a745; margin-bottom: 15px; }
            .product-price.sale { color: #555; }
            .product-price.sale del { color: #aaa; }
            .product-price.sale strong { color: #dc3545; font-size: 1.1em; }
            .buy-btn { background-color: #28a745; width: 100%; padding: 10px; font-size: 14px; }
            .product-card.out-of-stock { opacity: 0.6; }
            .product-card.out-of-stock .buy-btn { background-color: #6c757d; cursor: not-allowed; }
            .marquee-container { overflow: hidden; white-space: nowrap; background: #fffbe6; color: #856404; padding: 10px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ffeeba; }
            .marquee-text { display: inline-block; padding-left: 100%; animation: marquee 15s linear infinite; }
            @keyframes marquee { 0% { transform: translateX(0); } 100% { transform: translateX(-100%); } }
        </style>
        </head>
        <body><div class="container" style="max-width: 800px;">
            <div class="nav-links">
                <a href="/user-info" class="info-btn">My Info</a>
                <a href="/logout" class="logout-btn">Logout</a>
            </div>
            ${announcementHtml}
            <div class="balance-box">
                <div class="balance-label">Welcome, ${user.username}!</div>
                <div class="balance-amount">${formatCurrency(user.balance)} Ks</div>
            </div>
            <h2>🛒 Shop Items:</h2>
            <div class="product-grid">
                ${products.length > 0 ? productListHtml : '<p>No products available yet.</p>'}
            </div>
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

// --- START: REVISED FUNCTION (USER REQUEST) ---
// UPDATED: User Info UI (Alignment, Scroll, Inline Redeem, How to Top Up, Purchased Codes)
async function handleUserInfoPage(req: Request, user: User): Promise<Response> {
    const transactions = await getTransactions(user.username);
    
    const url = new URL(req.url);
    const message = url.searchParams.get("message");
    const error = url.searchParams.get("error");
    const value = url.searchParams.get("value");
    const recipient = url.searchParams.get("recipient");

    let messageHtml = "";
    if (message === "redeem_success") messageHtml = `<div class="success-msg">Success! ${formatCurrency(parseInt(value || "0"))} Ks was added to your balance.</div>`;
    if (message === "transfer_success") messageHtml = `<div class="success-msg">Success! You sent ${formatCurrency(parseInt(value || "0"))} Ks to ${recipient}.</div>`;
    if (error) messageHtml = `<div class="error" style="margin-top: 15px;">${decodeURIComponent(error)}</div>`;

    function toMyanmarTime(utcString: string): string {
        try { return new Date(utcString).toLocaleString("en-US", { timeZone: MYANMAR_TIMEZONE, hour12: true }); } 
        catch (e) { return utcString; }
    }

    const allPurchases = transactions.filter(t => t.type === 'purchase');
    const digitalPurchases = allPurchases.filter(t => t.itemDetails);
    const normalPurchases = allPurchases.filter(t => !t.itemDetails);

    const topUpHistory = transactions.filter(t => t.type === 'topup')
        .map(t => `<li class="topup"><span><strong>${t.itemName || 'Top Up'}</strong> <strong>+${formatCurrency(t.amount)} Ks</strong></span><span class="time">${toMyanmarTime(t.timestamp)}</span></li>`).join('');
    
    const purchaseHistory = normalPurchases
        .map(t => `<li class="purchase"><span>${t.itemName.includes('Transfer to') ? t.itemName : `Bought <strong>${t.itemName || 'an item'}</strong>`} for <strong>${formatCurrency(Math.abs(t.amount))} Ks</strong></span><span class="time">${toMyanmarTime(t.timestamp)}</span></li>`)
        .join('');

    // List of purchased digital codes
    const digitalCodesHtml = digitalPurchases
        .map((t, index) => {
            const codeId = `code-${index}`;
            return `
            <li class="purchase">
                <div style="flex-grow: 1;">
                    <strong>${t.itemName}</strong><br>
                    <code class="voucher-code" id="${codeId}">${t.itemDetails}</code>
                </div>
                <div class="actions">
                    <span class="time">${toMyanmarTime(t.timestamp)}</span>
                    <button class="copy-btn" onclick="copyToClipboard('${codeId}', this)">Copy</button>
                </div>
            </li>
            `;
        }).join('');


    const html = `
        <!DOCTYPE html><html lang="my"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>My Info</title>
        <style>${globalStyles}
            .profile-header { display: flex; align-items: center; margin-bottom: 20px; }
            .avatar { width: 60px; height: 60px; border-radius: 50%; background-color: #eee; margin-right: 15px; display: flex; justify-content: center; align-items: center; overflow: hidden; }
            .avatar svg { width: 32px; height: 32px; color: #aaa; }
            
            /* --- REVISED: Normal Alignment (USER REQUEST) --- */
            .profile-info { display: flex; align-items: center; gap: 10px; } 

            /* --- REVISED: Normal Font Size (USER REQUEST) --- */
            .profile-name { font-size: 1.3em; font-weight: 600; color: #333; margin: 0; user-select: all; }
            .copy-btn-small { background: #007bff; color: white; border: none; padding: 5px 10px; font-size: 12px; border-radius: 5px; cursor: pointer; }
            
            .form-box { margin-bottom: 25px; background: #f9f9f9; padding: 20px; border-radius: 8px; }
            .form-box h2 { margin-top: 0; }
            .form-box input { width: 90%; }
            .form-box button { width: auto; background-color: #17a2b8; }
            .form-box button.transfer { background-color: #fd7e14; }
            
            .history { margin-top: 25px; }
            .history h2 { border-bottom: 1px solid #eee; padding-bottom: 5px; }
            .history-list { max-height: 250px; overflow-y: auto; background-color: #fcfcfc; border: 1px solid #eee; padding: 10px; border-radius: 8px; }
            .history ul { padding-left: 0; list-style-type: none; margin: 0; }
            .history li { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; padding: 12px; background: #fff; border: 1px solid #eee; border-radius: 8px; border-left-width: 5px; }
            .history li.topup { border-left-color: #28a745; }
            .history li.purchase { border-left-color: #ffc107; }
            .history li .time { font-size: 0.9em; color: #777; display: block; margin-top: 5px; text-align: left; }
            .voucher-code { font-size: 1.1em; color: #d63384; user-select: all; }
            .copy-btn { background-color: #007bff; color: white; border: none; padding: 5px 10px; border-radius: 5px; font-size: 12px; cursor: pointer; }

            .payment-info { background: #fffbe6; border: 1px solid #ffeeba; border-radius: 8px; padding: 20px; }
            .payment-info h2 { margin-top: 0; }
            .payment-list { padding-left: 0; list-style: none; margin-top: 15px; }
            .payment-account { display: grid; grid-template-columns: 100px auto; align-items: center; margin-bottom: 12px; font-size: 1.1em; }
            .payment-account strong { font-weight: 600; color: #333; }
            .payment-account .details { display: flex; flex-direction: column; }
            .payment-account .number { font-weight: 600; color: #0056b3; }
            .payment-account .name { font-size: 0.9em; color: #555; }
            .telegram-link { display: flex; align-items: center; font-weight: 600; font-size: 1.1em; }
            .telegram-link svg { width: 24px; height: 24px; margin-right: 8px; color: #0088cc; }
        </style></head>
        <body><div class="container">
        
        <div class="profile-header">
            <div class="avatar">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A1.875 1.875 0 0 1 18 22.5H6c-.98 0-1.813-.73-1.93-1.703a1.875 1.875 0 0 1 .03-1.179Z" /></svg>
            </div>
                        <div class="profile-info">
                <span class="profile-name" id="username-text">${user.username}</span>
                <button class="copy-btn-small" onclick="copyToClipboard('username-text', this)">Copy</button>
            </div>
  __     </div>
        
        ${messageHtml} <div class="form-box payment-info">
            <h2>ငွေဖြည့်နည်း</h2>
            <p style="margin-top:0; color:#555;">Voucher Code ဝယ်ယူရန် (သို့) Admin မှ တိုက်ရိုက်ငွေဖြည့်ရန် Telegram မှ ဆက်သွယ်ပါ။</p>
            <div class="payment-list">
                <a href="https://t.me/iqowoq" target="_blank" class="telegram-link">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19.467 1.817a1.68 1.68 0 0 0-1.57-.002L3.58 6.471A1.68 1.68 0 0 0 2.21 7.91v1.314a1.68 1.68 0 0 0 .58 1.258l5.96 4.708a.75.75 0 0 1 .31.623v5.04a.75.75 0 0 0 1.25.59L12 19.333l3.22 2.451a.75.75 0 0 0 1.25-.59v-5.04a.75.75 0 0 1 .31-.623l5.96-4.708a1.68 1.68 0 0 0 .58-1.258V7.91a1.68 1.68 0 0 0-1.37-1.443L19.467 1.817Z" /></svg>
                    <span>@iqowoq</span>
                </a>
                <hr style="border:0; border-top:1px solid #eee; margin: 15px 0;">
                <div class="payment-account"><strong>KPay:</strong><div class="details"><span class="number">09961650283</span><span class="name">thein naing win</span></div></div>
                <div class="payment-account"><strong>Wave Pay:</strong><div class="details"><span class="number">09688171999</span><span class="name">thein naing win</span></div></div>
            </div>
        </div>

        <div class="form-box">
            <h2>Redeem Voucher</h2>
            <form action="/redeem_voucher" method="POST" style="display: flex; gap: 10px;">
                <input type="text" id="code" name="code" required style="text-transform: uppercase; margin: 0; flex: 1;" placeholder="Enter code">
                <button type="submit" class="redeem">Redeem</button>
            </form>
        </div>
        
        <div class="form-box">
            <h2>Transfer Funds</h2>
            <form action="/transfer_funds" method="POST">
                <label>Recipient's Name:</label><input type="text" name="recipient_name" required style="width: 95%;">
                <label style="margin-top: 10px; display: block;">Amount (Ks):</label><input type="number" name="transfer_amount" required style="width: 95%;">
                <button type="submit" class="transfer" style="width: 100%; margin-top: 15px;">Send Money</button>
            </form>
        </div>
        
        <div class="history">
            <h2>My Purchased Codes/Accounts</h2>
            <div class="history-list">
                ${digitalCodesHtml.length > 0 ? `<ul>${digitalCodesHtml}</ul>` : '<p>You have not purchased any digital items yet.</p>'}
            </div>
        </div>

        <div class="history">
            <h2>Transaction History</h2>
            <div class="history-list">
                ${topUpHistory.length > 0 ? `<ul>${topUpHistory}</ul>` : ''}
                ${purchaseHistory.length > 0 ? `<ul>${purchaseHistory}</ul>` : ''}
                ${topUpHistory.length === 0 && purchaseHistory.length === 0 ? '<p>No transactions yet.</p>' : ''}
            </div>
        </div>
        
        <a href="/dashboard" style="display:block; text-align:center; margin-top:20px;">Back to Shop</a>
        
        </div>
        <script>
            function copyToClipboard(elementId, buttonElement) {
                const text = document.getElementById(elementId).innerText;
                navigator.clipboard.writeText(text).then(() => {
                    buttonElement.innerText = "Copied!";
                    setTimeout(() => { buttonElement.innerText = "Copy"; }, 2000); // REVISED
                }, (err) => {
                    alert("Failed to copy.");
                });
            }
        </script>
        </body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}
// --- END: REVISED FUNCTION ---


// ----------------------------------------------------
// Action Handlers (Processing POST requests)
// ----------------------------------------------------

async function handleAuth(formData: FormData): Promise<Response> {
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();
    const remember = formData.get("remember") === "on";

    if (!username || !password) {
        const headers = new Headers();
        headers.set("Location", "/login?error=missing");
        return new Response("Redirecting...", { status: 302, headers });
    }
    const user = await getUserByUsername(username);
    if (!user) {
        const headers = new Headers();
        headers.set("Location", "/login?error=invalid");
        return new Response("Redirecting...", { status: 302, headers });
    }
    
    if (user.isBlocked) {
        const headers = new Headers();
        headers.set("Location", "/login?error=blocked");
        return new Response("Redirecting...", { status: 302, headers });
    }
    
    if (!verifyPassword(password, user.passwordHash)) {
        const headers = new Headers();
        headers.set("Location", "/login?error=invalid");
        return new Response("Redirecting...", { status: 302, headers });
    }
    
    const headers = createSession(username, remember); 
    return new Response("Login successful. Redirecting...", { status: 302, headers });
}

async function handleRegister(formData: FormData): Promise<Response> {
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();
    const remember = formData.get("remember") === "on";

    if (!username || !password) return new Response("Missing username or password.", { status: 400 });

    const passwordHash = password; 
    const success = await registerUser(username, passwordHash);

    if (success) {
      _ const headers = createSession(username, remember); 
        return new Response("Account created. Logging in...", { status: 302, headers });
    } else {
        const headers = new Headers();
        headers.set("Location", "/register?error=exists");
        return new Response("User exists. Redirecting...", { status: 302, headers });
    }
}

async function handleBuy(formData: FormData, username: string): Promise<Response> {
    const productId = formData.get("productId")?.toString();
    
    if (!productId) {
        return renderMessagePage("Error", "Invalid item ID.", true);
    }
    
    const productResult = await getProductById(productId);
    if (!productResult || !productResult.value) {
        return renderMessagePage("Error", "Item not found.", true);
    }

    const product = productResult.value;
    const price = (product.salePrice && product.salePrice > 0) ? product.salePrice : product.price;
    const item = product.name;
    let itemDetails: string | undefined = undefined; 

    const user = await getUserByUsername(username);
    if (!user || user.balance < price) {
        const message = `You have ${formatCurrency(user?.balance ?? 0)} Ks but need ${formatCurrency(price)} Ks. Please contact admin for a top-up.`;
        return renderMessagePage("Insufficient Balance", message, true);
    }

    if (product.isDigital) {
        if (!product.stock || product.stock.length === 0) {
            return renderMessagePage("Error", "Sorry, this item is Out of Stock.", true);
        }
        
        const itemToSell = product.stock[0]; 
        const newStock = product.stock.slice(1); 
        
        const atomicRes = await kv.atomic()
            .check(productResult) 
            .set(["products", product.id], { ...product, stock: newStock })
            .commit();
            
        if (!atomicRes.ok) {
            return renderMessagePage("Error", "Item was just sold! Please try again.", true);
        }
        
        itemDetails = itemToSell; 
    }

    const success = await updateUserBalance(username, -price); 

    if (success) {
        await logTransaction(username, -price, "purchase", item, itemDetails); 
        const newBalance = (await getUserByUsername(username))?.balance ?? 0;
        
        let detailsMessage = "";
        let reminderMessage = "";

        if (itemDetails) {
            detailsMessage = `<br><br>Your purchased item details:<br><strong style="font-size: 1.2em; color: #d63384;">${itemDetails}</strong>`;
            reminderMessage = "<br><br><small>This page will auto-redirect. You can view this code again in your 'My Info' page.</small>";
        }
        
        const message = `You bought <strong>${item}</strong> for ${formatCurrency(price)} Ks.<br>Your new balance is <strong>${formatCurrency(newBalance)} Ks</strong>.${detailsMessage}${reminderMessage}`;
        
        return renderMessagePage("Purchase Successful!", message, false); // Auto-redirects
    } else {
        return renderMessagePage("Transaction Failed", "An unknown error occurred.", true);
    }
}

async function handleAdminAdjustBalance(formData: FormData): Promise<Response> {
    const username = formData.get("name")?.toString();
    const amountStr = formData.get("amount")?.toString();
    const amount = amountStr ? parseInt(amountStr) : NaN;
    const token = formData.get("token")?.toString();
    const adminBackLink = `/admin/panel?token=${token}`;
    
    if (!username || isNaN(amount) || amount === 0) {
        return renderMessagePage("Error", "Missing 'name' or invalid 'amount' (cannot be zero).", true, adminBackLink);
    }

    const success = await updateUserBalance(username, amount);

    if (success) {
        const type = amount > 0 ? "topup" : "purchase";
        const itemName = amount > 0 ? "Admin Top-Up" : "Admin Deduction";
        await logTransaction(username, amount, type, itemName); 
        
        const message = amount > 0 ? "User balance updated!" : "User balance deducted!";
        const headers = new Headers();
        headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent(message)}`);
        return new Response("Redirecting...", { status: 302, headers });
    } else {
        return renderMessagePage("Error", `Failed to update balance. User may not exist or operation would result in negative balance.`, true, adminBackLink);
    }
}

async function handleAddProduct(formData: FormData): Promise<Response> {
    const name = formData.get("name")?.toString();
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;
    const salePriceStr = formData.get("sale_price")?.toString();
    const salePrice = (salePriceStr && parseInt(salePriceStr) > 0) ? parseInt(salePriceStr) : null;
    const imageUrl = formData.get("imageUrl")?.toString();
    const token = formData.get("token")?.toString();
    const isDigital = formData.get("isDigital") === "on";
    const stockString = formData.get("stock")?.toString() || "";
    const stock = isDigital ? stockString.split('\n').filter(s => s.trim() !== '') : [];
    
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!name || isNaN(price) || price <= 0 || !imageUrl) {
        return renderMessagePage("Error", "Missing name, price, or image URL.", true, adminBackLink);
    }
    
    await addProduct(name, price, salePrice, imageUrl, isDigital, stock);
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent("Product added!")}`);
    return new Response("Redirecting...", { status: 302, headers });
}

async function handleUpdateProduct(formData: FormData): Promise<Response> {
    const productId = formData.get("productId")?.toString();
    const name = formData.get("name")?.toString();
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;
    const salePriceStr = formData.get("sale_price")?.toString();
    const salePrice = (salePriceStr && parseInt(salePriceStr) > 0) ? parseInt(salePriceStr) : null;
    const imageUrl = formData.get("imageUrl")?.toString();
    const token = formData.get("token")?.toString();
    const isDigital = formData.get("isDigital") === "on";
    const stockString = formData.get("stock")?.toString() || "";
    const stock = isDigital ? stockString.split('\n').filter(s => s.trim() !== '') : [];
    
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!productId || !name || isNaN(price) || price <= 0 || !imageUrl) {
        return renderMessagePage("Error", "Missing data for update.", true, adminBackLink);
    }
    
    await updateProduct(productId, name, price, salePrice, imageUrl, isDigital, stock);
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent("Product updated!")}`);
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
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent("Product deleted!")}`);
    return new Response("Redirecting...", { status: 302, headers });
}

async function handleResetPassword(formData: FormData): Promise<Response> {
    const username = formData.get("name")?.toString();
    const newPassword = formData.get("new_password")?.toString();
    const token = formData.get("token")?.toString();
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!username || !newPassword) {
        return renderMessagePage("Error", "Missing username or new password.", true, adminBackLink);
    }

    const success = await resetUserPassword(username, newPassword);

    if (success) {
        const headers = new Headers();
        headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent("Password reset successfully!")}`);
        return new Response("Redirecting...", { status: 302, headers });
    } else {
        return renderMessagePage("Error", `Failed to reset password for ${username}. User may not exist.`, true, adminBackLink);
    }
}

async function handleToggleBlock(formData: FormData): Promise<Response> {
    const username = formData.get("name")?.toString();
    const token = formData.get("token")?.toString();
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!username) {
        return renderMessagePage("Error", "Missing username.", true, adminBackLink);
    }

    const message = await toggleBlockUser(username);

    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent(message)}`);
    return new Response("Redirecting...", { status: 302, headers });
}


async function handleRedeemVoucher(formData: FormData, username: string): Promise<Response> {
    const code = formData.get("code")?.toString().toUpperCase();
    const headers = new Headers();
    headers.set("Location", "/user-info"); 

    if (!code) {
        headers.set("Location", `/user-info?error=${encodeURIComponent("Invalid code.")}`);
        return new Response("Redirecting...", { status: 302, headers });
    }

    const result = await getVoucherByCode(code);
    if (!result || !result.value) {
        headers.set("Location", `/user-info?error=${encodeURIComponent("Voucher not valid.")}`);
        return new Response("Redirecting...", { status: 302, headers });
    }
    
    const voucher = result.value;
    
    if (voucher.isUsed) {
        headers.set("Location", `/user-info?error=${encodeURIComponent("Voucher already used.")}`);
        return new Response("Redirecting...", { status: 302, headers });
    }
    
    const atomicRes = await kv.atomic()
        .check(result) 
        .set(result.key, { ...voucher, isUsed: true })
        .commit();
        
    if (!atomicRes.ok) {
        headers.set("Location", `/user-info?error=${encodeURIComponent("Redemption failed. Please try again.")}`);
        return new Response("Redirecting...", { status: 302, headers });
    }
    
    await updateUserBalance(username, voucher.value);
    await logTransaction(username, voucher.value, "topup", `Voucher: ${voucher.code}`);
D     
    headers.set("Location", `/user-info?message=redeem_success&value=${voucher.value}`);
    return new Response("Redirecting...", { status: 302, headers });
}

async function handleTransfer(formData: FormData, username: string): Promise<Response> {
    const recipientName = formData.get("recipient_name")?.toString();
    const amountStr = formData.get("transfer_amount")?.toString();
    const amount = amountStr ? parseInt(amountStr) : NaN;
    
    const headers = new Headers();
    headers.set("Location", "/user-info"); 

    if (!recipientName || isNaN(amount) || amount <= 0) {
        headers.set("Location", `/user-info?error=${encodeURIComponent("Invalid name or amount.")}`);
        return new Response("Redirecting...", { status: 302, headers });
    }

    const result = await transferBalance(username, recipientName, amount);

    if (result === "success") {
        headers.set("Location", `/user-info?message=transfer_success&value=${amount}&recipient=${recipientName}`);
    } else {
        headers.set("Location", `/user-info?error=${encodeURIComponent(result)}`);
    }
    return new Response("Redirecting...", { status: 302, headers });
}


async function handleCreateVoucher(formData: FormData): Promise<Response> {
    const amountStr = formData.get("amount")?.toString();
    const amount = amountStr ? parseInt(amountStr) : NaN;
    const token = formData.get("token")?.toString();
    const adminBackLink = `/admin/panel?token=${token}`;
    
    if (isNaN(amount) || amount <= 0) {
        return renderMessagePage("Error", "Invalid amount.", true, adminBackLink);
    }
    
    await generateVoucher(amount);
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent("Voucher created!")}`);
    return new Response("Redirecting...", { status: 302, headers });
}

async function handleSetAnnouncement(formData: FormData): Promise<Response> {
    const message = formData.get("message")?.toString() || "";
    const token = formData.get("token")?.toString();
    
    await setAnnouncement(message);
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent("Announcement updated!")}`);
    return new Response("Redirecting...", { status: 302, headers });
}


function handleLogout(): Response {
    const headers = new Headers();
    headers.set("Location", "/login");
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=deleted; Path=/; Max-Age=0; HttpOnly`); 
    return new Response("Logged out. Redirecting...", { status: 302, headers });
}

// ----------------------------------------------------
// Main Server Router (RE-WRITTEN FOR STABILITY)
// ----------------------------------------------------

// Helper to check auth status and block
async function authenticateUser(req: Request): Promise<User | null> {
    const username = getUsernameFromCookie(req);
    if (!username) return null;

    const user = await getUserByUsername(username);
    if (!user) return null;

    if (user.isBlocked) return null; // Treat blocked as not logged in

    return user;
}


async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;
    
    // --- Handle GET requests ---
    if (req.method === "GET") {
        if (pathname === "/login") return renderLoginForm(req); 
        if (pathname === "/register") return renderRegisterForm(req); 
        if (pathname === "/logout") return handleLogout();

        // Admin GET
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
            if (!product || !product.value) return renderMessagePage("Error", "Product not found.", true, `/admin/panel?token=${token}`);
            return await renderEditProductPage(token, product.value);
        }

        // User GET (Protected)
        const user = await authenticateUser(req);
        if (!user) {
            if(pathname === "/" || pathname === "/dashboard" || pathname === "/user-info") {
                return handleLogout(); // Redirect to login
            }
        } else {
             if (pathname === "/" || pathname === "/dashboard") return await handleDashboard(user);
             if (pathname === "/user-info") return await handleUserInfoPage(req, user);
        }
    }
    
    // --- Handle POST requests ---
    if (req.method === "POST") {
        const formData = await req.formData(); // Read form data ONCE

        // Public POST
        if (pathname === "/auth") return await handleAuth(formData);
        if (pathname === "/doregister") return await handleRegister(formData);

        // User 'Buy' & 'Redeem' POST (Protected)
        const user = await authenticateUser(req); // Check auth AND block status
        if (user) {
            if (pathname === "/buy") return await handleBuy(formData, user.username);
G           if (pathname === "/redeem_voucher") return await handleRedeemVoucher(formData, user.username); 
            if (pathname === "/transfer_funds") return await handleTransfer(formData, user.username); 
        } else if (pathname === "/buy" || pathname === "/redeem_voucher" || pathname === "/transfer_funds") {
m           return handleLogout(); // Not logged in or blocked, redirect
        }

        // Admin POST (Protected)
        const token = formData.get("token")?.toString();
        if (token !== ADMIN_TOKEN) {
            return renderMessagePage("Error", "Unauthorized: Invalid Token.", true);
        }

        if (pathname === "/admin/adjust_balance") return await handleAdminAdjustBalance(formData);
        if (pathname === "/admin/add_product") return await handleAddProduct(formData);
        if (pathname === "/admin/update_product") return await handleUpdateProduct(formData);
        if (pathname === "/admin/delete_product") return await handleDeleteProduct(formData);
        if (pathname === "/admin/reset_password") return await handleResetPassword(formData); 
        if (pathname === "/admin/create_voucher") return await handleCreateVoucher(formData); 
        if (pathname === "/admin/set_announcement") return await handleSetAnnouncement(formData);s
        if (pathname === "/admin/toggle_block") return await handleToggleBlock(formData);
    }

    // --- Default Route (Redirect all other requests to login) ---
    const headers = new Headers();
    headers.set("Location", "/login");
    return new Response("Redirecting to /login...", { status: 302, headers });
}

// Start the Deno Server
Deno.serve(handler);
