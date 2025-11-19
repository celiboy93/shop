// main.ts (v2.2 - Fix Syntax Error & Clean Up)

// --- Deno KV Database Setup ---
const kv = await Deno.openKv(); 

// --- Configuration and Security ---
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") || "hardcoded_admin_pass"; 
const SESSION_COOKIE_NAME = "session_id";
const MYANMAR_TIMEZONE = "Asia/Yangon";

// Rate Limiting Configuration
const RATE_LIMIT_WINDOW_MS = 60000; // 60 seconds
const MAX_REQUESTS_PER_WINDOW = 5; // 5 requests per user/IP

// Tier Configuration
const TIER_THRESHOLDS = {
    "Bronze": 0,
    "Silver": 50000,
    "Gold": 200000
} as const;

// --- Data Structures ---
interface User {
    username: string;
    passwordHash: string;
    balance: number;
    isBlocked?: boolean; 
    receivedBonus?: boolean;
    lifetimeSpend: number | undefined; 
    tier: keyof typeof TIER_THRESHOLDS | undefined; 
}
interface Transaction {
    type: "topup" | "purchase";
    amount: number;
    timestamp: string; 
    itemName?: string; 
    itemDetails?: string; 
    isRolledBack?: boolean; 
}
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
    isSharedStock: boolean;
    stock: string[]; 
    category: string; 
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
interface PaymentInfo {
    instructions: string;
    telegramUser: string;
    kpayLogoUrl: string;
    kpayNumber: string;
    kpayName: string;
    waveLogoUrl: string;
    waveNumber: string;
    waveName: string;
}
interface GlobalBonus {
    isActive: boolean;
    amount: number;
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

function calculateTier(spend: number): User['tier'] {
    if (spend >= TIER_THRESHOLDS.Gold) return "Gold";
    if (spend >= TIER_THRESHOLDS.Silver) return "Silver";
    return "Bronze";
}

async function hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

async function verifyHash(inputPassword: string, storedHash: string): Promise<boolean> {
    const inputHash = await hashPassword(inputPassword);
    return inputHash === storedHash;
}

async function checkRateLimit(identifier: string): Promise<boolean> {
    const key = ["rate_limit", identifier];
    const result = await kv.get<number>(key);
    const currentCount = result.value || 0;

    if (currentCount >= MAX_REQUESTS_PER_WINDOW) {
        return false; 
    }

    await kv.set(key, currentCount + 1, { expireIn: RATE_LIMIT_WINDOW_MS });
    return true; 
}

// ----------------------------------------------------
// Core KV Functions (Data Management)
// ----------------------------------------------------

async function getUserByUsername(username: string): Promise<User | null> {
    const key = ["users", username];
    const result = await kv.get<User>(key);
    return result.value;
}

async function getAllUsers(): Promise<User[]> {
    const entries = kv.list<User>({ prefix: ["users"] });
    const users: User[] = [];
    for await (const entry of entries) {
        users.push(entry.value);
    }
    return users.sort((a, b) => a.username.localeCompare(b.username));
}

async function getSalesSummary(): Promise<{ totalUsers: number, totalRevenue: number, totalSales: number }> {
    const allUsersEntries = kv.list<User>({ prefix: ["users"] });
    const allTransactionsEntries = kv.list<Transaction>({ prefix: ["transactions"] });

    let totalUsers = 0;
    let totalRevenue = 0; 
    let totalSales = 0;    

    for await (const entry of allUsersEntries) {
        totalUsers++;
    }

    for await (const entry of allTransactionsEntries) {
        const t = entry.value;

        if (t.isRolledBack) {
            continue;
        }

        if (t.type === "topup" && t.amount > 0) {
            totalRevenue += t.amount;
        } else if (t.type === "purchase" && t.amount < 0) {
            totalSales += Math.abs(t.amount);
        }
    }

    return { totalUsers, totalRevenue, totalSales };
}

async function updateUserSpendAndTier(username: string, spendChange: number): Promise<boolean> {
    const key = ["users", username];
    while (true) {
        const result = await kv.get<User>(key);
        const user = result.value;
        if (!user) return false;

        const currentSpend = user.lifetimeSpend ?? 0;
        const newLifetimeSpend = currentSpend + spendChange;
        
        const finalSpend = Math.max(0, newLifetimeSpend); 
        const newTier = calculateTier(finalSpend);

        const updatedUser = { 
            ...user, 
            lifetimeSpend: finalSpend,
            tier: newTier
        };

        const res = await kv.atomic().check(result).set(key, updatedUser).commit();
        if (res.ok) return true;
    }
}

async function registerUser(username: string, passwordHash: string): Promise<boolean> {
    const bonus = await getGlobalBonus();
    let startBalance = 0;
    let hasReceived = false;

    if (bonus && bonus.isActive) {
        startBalance = bonus.amount;
        hasReceived = true;
    }
    
    const initialSpend = 0; 

    const user: User = { 
        username, 
        passwordHash, 
        balance: startBalance, 
        isBlocked: false,
        receivedBonus: hasReceived,
        lifetimeSpend: initialSpend,
        tier: calculateTier(initialSpend) 
    };
    
    const key = ["users", username];
    const res = await kv.atomic().check({ key, versionstamp: null }).set(key, user).commit();
    
    if (res.ok && startBalance > 0) {
        await logTransaction(username, startBalance, "topup", "Welcome Bonus");
    }
    
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

// Admin Reset Password
async function resetUserPassword(username: string, newPasswordHash: string): Promise<boolean> {
    const key = ["users", username];
    const result = await kv.get<User>(key);
    const user = result.value;
    if (!user) return false; 
    
    const hashedPassword = await hashPassword(newPasswordHash);
    
    user.passwordHash = hashedPassword;
    const res = await kv.atomic().check(result).set(key, user).commit();
    return res.ok;
}

// User Change Password
async function changeUserPassword(username: string, oldPassword: string, newPassword: string): Promise<string> {
    const key = ["users", username];
    const result = await kv.get<User>(key);
    const user = result.value;
    
    if (!user) return "User not found.";
    
    // Verify Old Password
    const isOldCorrect = await verifyPassword(oldPassword, user.passwordHash);
    if (!isOldCorrect) return "Incorrect old password.";
    
    // Update with New Password
    const newHash = await hashPassword(newPassword);
    const updatedUser = { ...user, passwordHash: newHash };
    
    const res = await kv.atomic().check(result).set(key, updatedUser).commit();
    
    return res.ok ? "success" : "Failed to update password. Please try again.";
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

    const senderTimestamp = new Date().toISOString();
    const recipientTimestamp = new Date(Date.now() + 1).toISOString(); 

    const senderTransaction: Transaction = { 
        type: "purchase", 
        amount: -amount, 
        timestamp: senderTimestamp, 
        itemName: `Transfer to ${recipientUsername}` 
    };
    const recipientTransaction: Transaction = { 
        type: "topup", 
        amount: amount, 
        timestamp: recipientTimestamp, 
        itemName: `Transfer from ${senderUsername}` 
    };

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
            .check(senderResult)
            .check(recipientResult)
            .set(senderKey, { ...sender, balance: newSenderBalance })
            .set(recipientKey, { ...recipient, balance: newRecipientBalance })
            .set(["transactions", senderUsername, senderTimestamp], senderTransaction)
            .set(["transactions", recipientUsername, recipientTimestamp], recipientTransaction)
            .commit();
        
        if (res.ok) {
            await updateUserSpendAndTier(senderUsername, amount); 
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

async function getTransactions(username: string, limit: number, cursor: string | undefined): Promise<{ transactions: Transaction[], nextCursor: string | undefined }> {
    const entries = kv.list<Transaction>({ 
        prefix: ["transactions", username],
        limit: limit,
        cursor: cursor,
    }, { 
        reverse: true 
    });

    const transactions: Transaction[] = [];

    for await (const entry of entries) {
        transactions.push(entry.value);
    }
    
    return { transactions, nextCursor: entries.cursor };
}

async function getSpecificTransaction(username: string, timestamp: string): Promise<{value: Transaction, versionstamp: string, key: Deno.KvKey} | null> {
    const key = ["transactions", username, timestamp];
    const result = await kv.get<Transaction>(key);
    if (!result.value) return null;
    return { ...result, key: key };
}

async function handleRefundRollback(username: string, timestamp: string, adminUsername: string): Promise<string> {
    const transactionResult = await getSpecificTransaction(username, timestamp);
    if (!transactionResult) {
        return "Transaction not found for the given ID.";
    }

    const transaction = transactionResult.value;

    if (transaction.isRolledBack) {
        return "This transaction has already been rolled back.";
    }
    
    const originalAmount = Math.abs(transaction.amount);
    const rollbackAmount = transaction.type === "purchase" ? originalAmount : -originalAmount; 
    const rollbackType = rollbackAmount > 0 ? "topup" : "purchase";
    const rollbackItemName = `ROLLBACK/${transaction.type.toUpperCase()} by Admin ${adminUsername}`;

    const success = await updateUserBalance(username, rollbackAmount);

    if (!success) {
        return `Failed to update user balance. Rollback amount: ${rollbackAmount} Ks. (User may not exist or operation results in negative balance)`;
    }

    await logTransaction(username, rollbackAmount, rollbackType, rollbackItemName);

    if (transaction.type === 'purchase') {
        await updateUserSpendAndTier(username, -originalAmount);
    }

    transaction.isRolledBack = true;
    
    const updateOriginalRes = await kv.atomic()
        .check(transactionResult)
        .set(transactionResult.key, transaction)
        .commit();

    if (!updateOriginalRes.ok) {
        console.error(`Failed to mark original transaction ${username}/${timestamp} as rolled back.`);
    }

    return `Successfully reversed transaction. ${formatCurrency(Math.abs(rollbackAmount))} Ks has been ${rollbackAmount > 0 ? 'refunded to' : 'deducted from'} ${username}'s balance.`;
}


async function getDigitalSalesHistory(): Promise<DigitalSaleLog[]> {
    const entries = kv.list<Transaction>({ prefix: ["transactions"] });
    const logs: DigitalSaleLog[] = [];
    for await (const entry of entries) {
        const t = entry.value;
        if (t.type === 'purchase' && t.itemDetails) {
            logs.push({
                username: entry.key[1] as string, 
                itemName: t.itemName,
                itemDetails: t.itemDetails,
                timestamp: t.timestamp,
                amount: t.amount
            });
        }
    }
    return logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()); 
}

async function getAdminTopupHistory(searchTerm: string = ''): Promise<Transaction[]> {
    const term = searchTerm.toLowerCase();
    const entries = kv.list<Transaction>({ prefix: ["transactions"] });
    const logs: Transaction[] = [];
    for await (const entry of entries) {
        const t = entry.value;
        
        const isAdminCredit = t.itemName && 
            (t.itemName.includes('Admin Top-Up') || t.itemName.includes('Voucher:') || t.itemName.includes('ROLLBACK/PURCHASE'));

        if (t.type === 'topup' && isAdminCredit) {
            const username = entry.key[1] as string;
            const displayItemName = `${t.itemName} to ${username}`;
            
            if (term === '' || displayItemName.toLowerCase().includes(term)) {
                logs.push({ ...t, itemName: displayItemName }); 
            }
        }
    }
    return logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

async function deleteUserTransactions(username: string): Promise<void> {
    const entries = kv.list({ prefix: ["transactions", username] });
    const keysToDelete: Deno.KvKey[] = [];
    for await (const entry of entries) {
        keysToDelete.push(entry.key);
    }
    await Promise.all(keysToDelete.map(key => kv.delete(key)));
}

async function deleteAllUsersAndRelatedData(): Promise<string> {
    const userEntries = kv.list<User>({ prefix: ["users"] });
    let deletedCount = 0;
    
    for await (const entry of userEntries) {
        const username = entry.key[1] as string;
        
        await deleteUserTransactions(username);
        
        await kv.delete(entry.key);
        
        deletedCount++;
    }
    
    return `Successfully deleted ${deletedCount} users and their transaction history.`;
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

async function addProduct(name: string, price: number, salePrice: number | null, imageUrl: string, isDigital: boolean, stock: string[], category: string, isSharedStock: boolean): Promise<boolean> {
    const id = Date.now().toString(); 
    const product: Product = { id, name, price, salePrice, imageUrl, isDigital, stock: stock || [], category, isSharedStock };
    const key = ["products", id];
    const res = await kv.set(key, product);
    return res.ok;
}

async function updateProduct(id: string, name: string, price: number, salePrice: number | null, imageUrl: string, isDigital: boolean, stock: string[], category: string, isSharedStock: boolean): Promise<boolean> {
    const key = ["products", id];
    const product: Product = { id, name, price, salePrice, imageUrl, isDigital, stock: stock || [], category, isSharedStock }; 
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

// --- Payment Info KV Functions ---
async function getPaymentInfo(): Promise<PaymentInfo | null> {
    const key = ["payment_info"];
    const result = await kv.get<PaymentInfo>(key);
    return result.value;
}

async function setPaymentInfo(info: PaymentInfo): Promise<void> {
    const key = ["payment_info"];
    await kv.set(key, info);
}

// --- Global Bonus KV Functions ---
async function getGlobalBonus(): Promise<GlobalBonus | null> {
    const key = ["global_bonus"];
    const result = await kv.get<GlobalBonus>(key);
    return result.value;
}

async function setGlobalBonus(amount: number): Promise<void> {
    const key = ["global_bonus"];
    const bonusSetting = { amount: amount, isActive: amount > 0 };
    await kv.set(key, bonusSetting);

    // If bonus is activated, reset all users' 'receivedBonus' flag
    if (bonusSetting.isActive) {
        const entries = kv.list<User>({ prefix: ["users"] });
        const mutations: Promise<Deno.KvCommitResult | Deno.KvCommitError>[] = [];
        for await (const entry of entries) {
            if (entry.value.receivedBonus) { 
                 entry.value.receivedBonus = false; 
                 mutations.push(kv.set(entry.key, entry.value));
            }
        }
        await Promise.all(mutations);
    }
}


// ----------------------------------------------------
// Authentication Helpers (SECURE SESSION PATCH)
// ----------------------------------------------------

async function createSession(username: string, remember: boolean): Promise<string> {
    const token = crypto.randomUUID(); 
    const expireIn = remember ? 1000 * 60 * 60 * 24 * 30 : 1000 * 60 * 60; 
    
    await kv.set(["sessions", token], username, { expireIn });
    return token;
}

async function getUsernameFromSession(req: Request): Promise<string | null> {
    const cookieHeader = req.headers.get("Cookie");
    if (!cookieHeader || !cookieHeader.includes(SESSION_COOKIE_NAME)) return null;
    
    try {
        const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
        if (!match) return null;
        
        const token = decodeURIComponent(match[1].split(';')[0]);
        const result = await kv.get<string>(["sessions", token]);
        return result.value; 
    } catch (e) {
        console.error("Session check error:", e);
        return null;
    }
}

async function invalidateSession(req: Request): Promise<void> {
    const cookieHeader = req.headers.get("Cookie");
    if (!cookieHeader) return;
    const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
    if (match) {
        const token = decodeURIComponent(match[1].split(';')[0]);
        await kv.delete(["sessions", token]);
    }
}

async function verifyPassword(inputPassword: string, storedHash: string): Promise<boolean> {
    if (storedHash.length === 64 && /^[0-9a-fA-F]{64}$/.test(storedHash)) {
        return await verifyHash(inputPassword, storedHash);
    }
    return inputPassword === storedHash;
}

// ----------------------------------------------------
// HTML Render Functions (Pages)
// ----------------------------------------------------

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

const globalStyles = `
    @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
    body { 
        font-family: 'Myanmar Sans Pro', 'Pyidaungsu', 'Roboto', -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; 
        margin: 0; padding: 20px; 
        background-color: #f0f2f5; 
        display: flex; 
        justify-content: center; 
        align-items: center; 
        min-height: 90vh; 
        font-size: 16px; 
    }
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
    @media (max-width: 600px) {
        body { padding: 10px; }
        .container { padding: 20px 15px; }
    }
`;

function renderLoginForm(req: Request): Response {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    
    let errorHtml = "";
    if (error === 'invalid') errorHtml = '<p class="error">Invalid username or password. Please try again.</p>';
    if (error === 'missing') errorHtml = '<p class="error">Please enter both username and password.</p>';
    if (error === 'blocked') errorHtml = '<p class="error">Your account has been suspended by the admin.</p>';

    const html = `<!DOCTYPE html><html><head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Login</title>
        <style>${globalStyles}</style></head>
        <body><div class="container">
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
    const html = `<!DOCTYPE html><html><head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Register</title>
        <style>${globalStyles} button.register{background-color:#28a745;}</style></head>
        <body><div class="container">
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


async function renderAdminPanel(token: string, message: string | null, req: Request): Promise<Response> {
    let messageHtml = "";
    if (message) messageHtml = `<div class="success-msg">${decodeURIComponent(message)}</div>`;

    const url = new URL(req.url);
    const historySearchTerm = url.searchParams.get('history_search') || '';
    
    const summary = await getSalesSummary();
    const netFlow = summary.totalRevenue - summary.totalSales; 
    
    const products = await getProducts();
    const productListHtml = products.map(p => `
        <div class="product-item">
            <span>${p.name} (${p.category || 'General'}) ${p.isDigital ? `<strong>(${p.stock.length} left)</strong>` : ''} ${p.salePrice ? `<strong style="color:red;">(Sale)</strong>` : ''}</span>
            <div class="actions">
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
    const pInfo = await getPaymentInfo();
    const currentBonus = await getGlobalBonus();
    
    const salesHistory = await getDigitalSalesHistory();
    const salesHistoryHtml = salesHistory.map(s => `
        <div class="voucher-item">
            <span><strong>${s.username}</strong> bought <strong>${s.itemName}</strong></span>
            <span class="voucher-value">${toMyanmarTime(s.timestamp)}</span>
        </div>
    `).join('');

    const allUsers = await getAllUsers();
    const userBalanceListHtml = allUsers.map(u => `
        <div class="user-balance-item">
            <span class="username">${u.username} ${u.isBlocked ? '(BLOCKED)' : ''}</span>
            <span class="balance-amount">${formatCurrency(u.balance)} Ks</span>
        </div>
    `).join('');

    const adminTopups = await getAdminTopupHistory(historySearchTerm); 
    const adminTopupHistoryHtml = adminTopups.map(t => `
        <div class="voucher-item">
            <span><strong>${t.itemName}</strong> <strong>+${formatCurrency(t.amount)} Ks</strong></span>
            <span class="voucher-value">${toMyanmarTime(t.timestamp)}</span>
        </div>
    `).join('');

    const html = `
        <!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Admin Panel</title>
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>${globalStyles}
            button.admin{background-color:#28a745;} button.product{background-color:#ffc107; color:black;} button.reset{background-color:#dc3545;} button.voucher{background-color:#17a2b8;}
            button.announcement{background-color:#6610f2;} button.payment{background-color:#0dcaf0;}
            hr{margin:30px 0; border:0; border-top:1px solid #eee;}
            .product-item, .voucher-item { display:flex; justify-content:space-between; align-items:center; padding:10px; border-bottom:1px solid #eee; }
            .edit-btn { background-color:#007bff; color:white; padding:5px 10px; border-radius:4px; font-size: 14px; }
            .delete-btn { background-color:#dc3545; padding:5px 10px; font-size: 14px; }
            .voucher-code { font-weight: bold; background: #eee; padding: 3px 6px; border-radius: 4px; }
            .history-list, .balance-list { max-height: 300px; overflow-y: auto; background-color: #fcfcfc; border: 1px solid #eee; padding: 10px; border-radius: 8px; }
            .user-balance-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #eee; font-size: 1.1em; }
            .user-balance-item:last-child { border-bottom: none; }
            .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 25px; }
            .summary-card { background: #f8f8f8; padding: 15px; border-radius: 8px; border-left: 5px solid; }
            .card-users { border-left-color: #007bff; } .card-revenue { border-left-color: #28a745; } .card-sales { border-left-color: #ffc107; } .card-netflow { border-left-color: #6610f2; }
            .accordion-header { background-color: #007bff; color: white; padding: 15px; cursor: pointer; border-radius: 8px; margin-top: 10px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
            .accordion-content { padding: 15px; border: 1px solid #ddd; border-top: none; border-radius: 0 0 8px 8px; display: none; overflow: hidden; }
            .accordion-header.active { border-radius: 8px 8px 0 0; background-color: #0056b3; }
            .actions { display: flex; gap: 5px; }
            @media (max-width: 600px) { .container { max-width: 100%; } }
        </style></head>
        <body><div class="container" style="max-width: 700px;">
            ${messageHtml}

            <div class="accordion-header active" data-target="section1"><span>📈 Sales & User Management</span><span>▶</span></div>
            <div class="accordion-content" id="section1" style="display: block;">
                <h2>📈 Sales Summary</h2>
                <div class="summary-grid">
                    <div class="summary-card card-users"><p>Total Users</p><h3>${summary.totalUsers}</h3></div>
                    <div class="summary-card card-revenue"><p>Total Revenue</p><h3>${formatCurrency(summary.totalRevenue)} Ks</h3></div>
                    <div class="summary-card card-sales"><p>Total Sales</p><h3>${formatCurrency(summary.totalSales)} Ks</h3></div>
                    <div class="summary-card card-netflow"><p>Net Balance Flow</p><h3>${formatCurrency(netFlow)} Ks</h3></div>
                </div>
                <hr>
                <h2>User Balances (${allUsers.length} Users)</h2>
                <div class="balance-list">${userBalanceListHtml.length > 0 ? userBalanceListHtml : '<p>No users registered yet.</p>'}</div>
            </div>
            
            <div class="accordion-header" data-target="section2"><span>⚙️ Site Configuration</span><span>▶</span></div>
            <div class="accordion-content" id="section2">
                <h2>Announcement</h2>
                <form action="/admin/set_announcement" method="POST"><input type="hidden" name="token" value="${token}"><input type="text" name="message" value="${currentAnnouncement}"><br><br><button type="submit" class="announcement">Set Announcement</button></form><hr>
                <h2>Global Bonus</h2>
                <form action="/admin/set_global_bonus" method="POST"><input type="hidden" name="token" value="${token}"><input type="number" name="amount" value="${currentBonus?.isActive ? currentBonus.amount : '0'}" required><br><br><button type="submit" class="admin">Set Global Bonus</button></form><hr>
                <h2>Payment Info</h2>
                <form action="/admin/set_payment_info" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <textarea name="instructions" rows="3" style="width:95%;">${pInfo?.instructions || ''}</textarea><br><br>
                    <input type="text" name="telegramUser" value="${pInfo?.telegramUser || ''}" placeholder="Telegram User"><br><br>
                    <input type="url" name="kpayLogoUrl" value="${pInfo?.kpayLogoUrl || ''}" placeholder="KPay Logo"><br><br>
                    <input type="text" name="kpayNumber" value="${pInfo?.kpayNumber || ''}" placeholder="KPay Number"><br><br>
                    <input type="text" name="kpayName" value="${pInfo?.kpayName || ''}" placeholder="KPay Name"><br><br>
                    <input type="url" name="waveLogoUrl" value="${pInfo?.waveLogoUrl || ''}" placeholder="Wave Logo"><br><br>
                    <input type="text" name="waveNumber" value="${pInfo?.waveNumber || ''}" placeholder="Wave Number"><br><br>
                    <input type="text" name="waveName" value="${pInfo?.waveName || ''}" placeholder="Wave Name"><br><br>
                    <button type="submit" class="payment">Update Payment Info</button>
                </form>
            </div>

            <div class="accordion-header" data-target="section3"><span>🛍️ Product Management</span><span>▶</span></div>
            <div class="accordion-content" id="section3">
                <h2>Product List</h2><div class="product-list">${products.length > 0 ? productListHtml : '<p>No products yet.</p>'}</div><hr>
                <h2>Add New Product</h2>
                <form action="/admin/add_product" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <input type="text" name="name" required placeholder="Name"><br><br>
                    <input type="text" name="category" required placeholder="Category"><br><br>
                    <input type="url" name="imageUrl" required placeholder="Image URL"><br><br>
                    <input type="number" name="price" required placeholder="Price"><br><br>
                    <input type="number" name="sale_price" placeholder="Sale Price (Optional)"><br><br>
                    <input type="checkbox" name="isDigital" onchange="this.nextElementSibling.nextElementSibling.style.display=this.checked?'block':'none'"> Is Digital?<br><br>
                    <div style="display:none;"><textarea name="stock" rows="5" style="width: 95%;" placeholder="Stock lines..."></textarea><br>
                    <input type="checkbox" name="isSharedStock"> Shared Stock?</div>
                    <button type="submit" class="product">Add Product</button>
                </form>
            </div>

            <div class="accordion-header" data-target="section4"><span>👥 User Tools</span><span>▶</span></div>
            <div class="accordion-content" id="section4">
                <h2>Adjust Balance</h2>
                <form action="/admin/adjust_balance" method="POST"><input type="hidden" name="token" value="${token}"><input type="text" name="name" required placeholder="Username"><br><br><input type="number" name="amount" required placeholder="Amount"><br><br><button type="submit" class="admin">Adjust Balance</button></form><hr>
                <h2>Reset Password</h2>
                <form action="/admin/reset_password" method="POST"><input type="hidden" name="token" value="${token}"><input type="text" name="name" required placeholder="Username"><br><br><input type="text" name="new_password" required placeholder="New Password"><br><br><button type="submit" class="reset">Reset Password</button></form><hr>
                <h2>Block User</h2>
                <form action="/admin/toggle_block" method="POST"><input type="hidden" name="token" value="${token}"><input type="text" name="name" required placeholder="Username"><br><br><button type="submit" style="background-color:#555;">Toggle Block</button></form><hr>
                <h2>Admin History</h2>
                <form method="GET" action="/admin/panel"><input type="hidden" name="token" value="${token}"><input type="text" name="history_search" value="${historySearchTerm}" placeholder="Search"><button type="submit" class="admin">Search</button></form>
                <div class="history-list">${adminTopupHistoryHtml.length > 0 ? adminTopupHistoryHtml : '<p>No history.</p>'}</div><hr>
                <button type="button" class="reset" onclick="if(confirm('DELETE ALL DATA?')) document.getElementById('cleanupForm').submit()">DELETE ALL USERS</button>
            </div>

            <div class="accordion-header" data-target="section5"><span>🔙 Refund & Vouchers</span><span>▶</span></div>
            <div class="accordion-content" id="section5">
                <h2>Rollback</h2>
                <form action="/admin/rollback" method="POST"><input type="hidden" name="token" value="${token}"><input type="text" name="name" required placeholder="Username"><br><br><input type="text" name="timestamp" required placeholder="Transaction Key"><br><br><button type="submit" class="reset">Rollback</button></form><hr>
                <h2>Vouchers</h2>
                <form action="/admin/create_voucher" method="POST"><input type="hidden" name="token" value="${token}"><input type="number" name="amount" required placeholder="Amount"><br><br><button type="submit" class="voucher">Create Voucher</button></form>
                <div class="voucher-list">${vouchers.length > 0 ? voucherListHtml : '<p>No vouchers.</p>'}</div><hr>
                <h2>Sales History</h2><div class="history-list">${salesHistoryHtml.length > 0 ? salesHistoryHtml : '<p>No sales.</p>'}</div>
            </div>
        </div>
        <form id="cleanupForm" method="POST" action="/admin/cleanup"><input type="hidden" name="token" value="${token}"></form>
        <script>
            document.querySelectorAll('.accordion-header').forEach(h => h.addEventListener('click', () => {
                const c = document.getElementById(h.dataset.target);
                c.style.display = c.style.display === 'block' ? 'none' : 'block';
                h.classList.toggle('active');
            }));
        </script>
        </body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

async function renderEditProductPage(token: string, product: Product): Promise<Response> {
    const stockString = product.stock ? product.stock.join('\n') : '';
    const html = `<!DOCTYPE html><html><head><title>Edit</title><style>${globalStyles}</style></head>
        <body><div class="container"><h1>Edit Product</h1>
            <form action="/admin/update_product" method="POST">
                <input type="hidden" name="token" value="${token}"><input type="hidden" name="productId" value="${product.id}">
                <input type="text" name="name" required value="${product.name}"><br><br>
                <input type="text" name="category" required value="${product.category}"><br><br>
                <input type="url" name="imageUrl" required value="${product.imageUrl}"><br><br>
                <input type="number" name="price" required value="${product.price}"><br><br>
                <input type="number" name="sale_price" value="${product.salePrice || ''}"><br><br>
                <input type="checkbox" name="isDigital" ${product.isDigital?'checked':''} onchange="this.nextElementSibling.nextElementSibling.style.display=this.checked?'block':'none'"> Digital?<br><br>
                <div style="display:${product.isDigital?'block':'none'}"><textarea name="stock" rows="5" style="width: 95%;">${stockString}</textarea><br>
                <input type="checkbox" name="isSharedStock" ${product.isSharedStock?'checked':''}> Shared?</div>
                <button type="submit">Update</button>
            </form><a href="/admin/panel?token=${token}">Cancel</a>
        </div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

function renderMessagePage(title: string, message: string, isError = false, backLink: string | null = null): Response {
    const linkHref = backLink || "/dashboard";
    const metaRefresh = isError ? '' : `<meta http-equiv="refresh" content="3;url=${linkHref}">`; 
    const html = `<!DOCTYPE html><html><head><title>${title}</title>${metaRefresh}<style>${globalStyles} .container{text-align:center;}</style></head><body><div class="container"><h1>${title}</h1><p>${message}</p><a href="${linkHref}">Go Back</a></div></body></html>`;
    return new Response(html, { status: isError ? 400 : 200, headers: HTML_HEADERS });
}

async function handleDashboard(req: Request, user: User): Promise<Response> {
    const allProducts = await getProducts();
    const announcement = await getAnnouncement(); 
    const url = new URL(req.url); 
    const selectedCategory = url.searchParams.get("category") || 'All';
    
    const categories = Array.from(new Set(allProducts.map(p => p.category || 'General'))).sort();
    const products = selectedCategory === 'All' ? allProducts : allProducts.filter(p => (p.category || 'General') === selectedCategory);

    const categoryOptionsHtml = ['All', ...categories].map(cat => 
        `<a href="/dashboard?category=${encodeURIComponent(cat)}" style="margin-right:5px; text-decoration:${cat===selectedCategory?'underline':'none'}">${cat}</a>`
    ).join('');
    
    const productListHtml = products.map(product => {
        const hasSale = product.salePrice !== null && product.salePrice >= 0;
        const displayPrice = hasSale ? product.salePrice : product.price;
        const isOutOfStock = product.isDigital && (!product.stock || product.isSharedStock === false && product.stock.length === 0);
        return `
        <div style="border:1px solid #eee; padding:10px; border-radius:8px; text-align:center;">
            <img src="${product.imageUrl}" style="height:80px;">
            <h3>${product.name}</h3>
            <p>${hasSale ? `<del>${formatCurrency(product.price)}</del> <b>${formatCurrency(displayPrice)}</b>` : formatCurrency(product.price)} Ks</p>
            <form method="POST" action="/buy" onsubmit="return confirm('Buy ${product.name}?')">
                <input type="hidden" name="productId" value="${product.id}">
                <button type="submit" ${isOutOfStock?'disabled':''}>${isOutOfStock?'Out of Stock':'Buy'}</button>
            </form>
        </div>`;
    }).join('');
    
    const html = `<!DOCTYPE html><html><head><title>Shop</title><style>${globalStyles} .grid{display:grid; grid-template-columns:repeat(auto-fit, minmax(150px,1fr)); gap:10px;}</style></head>
        <body><div class="container" style="max-width:800px;">
            <div style="display:flex; justify-content:space-between;"><a href="/user-info">My Info</a><a href="/logout">Logout</a></div>
            ${announcement ? `<p style="background:#fffbe6; padding:10px;">📢 ${announcement}</p>` : ''}
            <div style="background:#007bff; color:white; padding:15px; border-radius:8px; text-align:center; margin:15px 0;">
                <h3>${user.username} (${user.tier || 'Bronze'})</h3><h1>${formatCurrency(user.balance)} Ks</h1>
            </div>
            <div style="margin-bottom:15px;">${categoryOptionsHtml}</div>
            <div class="grid">${products.length > 0 ? productListHtml : '<p>No products.</p>'}</div>
        </div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

async function handleUserInfoPage(req: Request, user: User): Promise<Response> {
    const url = new URL(req.url);
    const limit = 10;
    const currentCursor = url.searchParams.get('cursor') || undefined;
    const { transactions: allTransactions, nextCursor } = await getTransactions(user.username, limit, currentCursor);
    
    const message = url.searchParams.get("message");
    const error = url.searchParams.get("error");

    const filteredTransactions = allTransactions; 
    
    let messageHtml = "";
    if (message) messageHtml = `<div class="success-msg">${message}</div>`;
    if (error) messageHtml = `<div class="error">${decodeURIComponent(error)}</div>`;

    // Helper to safe-render list
    const digitalPurchases = filteredTransactions.filter(t => t.type === 'purchase' && t.itemDetails);
    const digitalCodesHtml = digitalPurchases.map(t => `<li><b>${t.itemName}</b>: <code style="background:#eee; padding:2px;">${t.itemDetails}</code></li>`).join('');
    const digitalSection = digitalCodesHtml ? `<ul>${digitalCodesHtml}</ul>` : '<p>No digital items.</p>';

    const nonDigital = filteredTransactions.filter(t => !t.itemDetails);
    const historyHtml = nonDigital.map(t => `
        <li style="border-left: 4px solid ${t.type==='topup'?'green':'orange'}; padding:5px; margin-bottom:5px; list-style:none;">
            ${t.itemName || 'Item'} (${formatCurrency(t.amount)} Ks) <br> <small>${toMyanmarTime(t.timestamp)}</small>
        </li>`).join('');
    const historySection = historyHtml ? `<ul>${historyHtml}</ul>` : '<p>No history.</p>';

    const paymentInfo = await getPaymentInfo();
    const paymentHtml = paymentInfo ? `<div style="background:#f9f9f9; padding:10px; margin-bottom:10px;">
        <b>Top Up Info:</b> ${paymentInfo.instructions} <br> KPay: ${paymentInfo.kpayNumber} | Wave: ${paymentInfo.waveNumber}
    </div>` : '';

    const currentParams = new URLSearchParams(url.searchParams);
    currentParams.delete('cursor');
    let nextLink = '';
    if (nextCursor) {
        currentParams.set('cursor', nextCursor);
        nextLink = `<a href="/user-info?${currentParams.toString()}">Next Page -></a>`;
    }

    const html = `<!DOCTYPE html><html><head><title>My Info</title><style>${globalStyles}</style></head>
        <body><div class="container">
        <div style="text-align:center;"><h2>${user.username}</h2><p>Spent: ${formatCurrency(user.lifetimeSpend||0)} Ks</p></div>
        ${messageHtml} ${paymentHtml}
        <div style="background:#f1f1f1; padding:15px; margin-bottom:10px; border-radius:8px;">
            <h3>Redeem</h3><form action="/redeem_voucher" method="POST"><input type="text" name="code" placeholder="CODE"><button>Redeem</button></form>
        </div>
        <div style="background:#f1f1f1; padding:15px; margin-bottom:10px; border-radius:8px;">
            <h3>Transfer</h3><form action="/transfer_funds" method="POST"><input type="text" name="recipient_name" placeholder="To User"><input type="number" name="transfer_amount" placeholder="Amount"><button style="background:orange;">Transfer</button></form>
        </div>
        <div style="background:#f1f1f1; padding:15px; margin-bottom:10px; border-radius:8px;">
            <h3>Password</h3><form action="/change_password" method="POST"><input type="password" name="old_password" placeholder="Old"><input type="password" name="new_password" placeholder="New"><button style="background:grey;">Change</button></form>
        </div>
        <h3>My Codes</h3>${digitalSection}
        <h3>History</h3>${historySection} ${nextLink}
        <br><a href="/dashboard">Back to Shop</a>
        </div></body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

// --- Action Handlers ---

async function handleAuth(formData: FormData): Promise<Response> {
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();
    if (!username || !password) return new Response("", { status: 302, headers: { "Location": "/login?error=missing" } });
    const user = await getUserByUsername(username);
    if (!user || user.isBlocked || !await verifyPassword(password, user.passwordHash)) return new Response("", { status: 302, headers: { "Location": "/login?error=invalid" } });

    const bonus = await getGlobalBonus();
    if (bonus && bonus.isActive && !user.receivedBonus) {
        const newBalance = user.balance + bonus.amount;
        const res = await kv.atomic().check({key: ["users", username], versionstamp: null}).set(["users", username], { ...user, balance: newBalance, receivedBonus: true }).commit();
        if (!res.ok) await kv.set(["users", username], { ...user, balance: newBalance, receivedBonus: true }); // Fallback
        await logTransaction(username, bonus.amount, "topup", "Event Bonus");
    }
    const token = await createSession(username, formData.get("remember") === "on");
    const headers = new Headers({"Location": "/dashboard", "Set-Cookie": `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax`});
    return new Response("", { status: 302, headers });
}

async function handleRegister(formData: FormData): Promise<Response> {
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();
    if (!username || !password) return new Response("Missing data", { status: 400 });
    const success = await registerUser(username, await hashPassword(password));
    if (success) {
        const token = await createSession(username, formData.get("remember") === "on");
        const headers = new Headers({"Location": "/dashboard", "Set-Cookie": `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax`});
        return new Response("", { status: 302, headers });
    }
    return new Response("", { status: 302, headers: { "Location": "/register?error=exists" } });
}

async function handleBuy(formData: FormData, username: string): Promise<Response> {
    if (!await checkRateLimit(username)) return renderMessagePage("Limit", "Slow down.", true);
    const productId = formData.get("productId")?.toString();
    const productRes = await getProductById(productId!);
    if (!productRes) return renderMessagePage("Error", "Item not found", true);
    const product = productRes.value;
    const user = (await getUserByUsername(username))!;
    const price = (product.salePrice!==null && product.salePrice>=0) ? product.salePrice : product.price;

    if (price > 0 && user.balance < price) return renderMessagePage("Low Balance", "Please Top Up", true);

    let itemDetails;
    if (product.isDigital) {
        if (!product.stock.length) return renderMessagePage("Stock", "Out of stock", true);
        itemDetails = product.stock[0];
        const newStock = product.isSharedStock ? product.stock : product.stock.slice(1);
        const res = await kv.atomic().check(productRes).set(["products", product.id], { ...product, stock: newStock }).commit();
        if (!res.ok) return renderMessagePage("Error", "Try again", true);
    }

    const success = await updateUserBalance(username, -price);
    if (success) {
        await logTransaction(username, -price, "purchase", product.name, itemDetails);
        await updateUserSpendAndTier(username, price);
        return renderMessagePage("Success", `Bought ${product.name}. ${itemDetails ? 'Code: '+itemDetails : ''}`, false);
    }
    return renderMessagePage("Error", "Transaction failed", true);
}

async function handleRedeemVoucher(formData: FormData, username: string): Promise<Response> {
    const code = formData.get("code")?.toString().toUpperCase();
    const res = await getVoucherByCode(code!);
    if (!res || res.value.isUsed) return new Response("", { status: 302, headers: { "Location": "/user-info?error=Invalid" } });
    const v = res.value;
    const ok = await kv.atomic().check(res).set(res.key, { ...v, isUsed: true }).commit();
    if (ok.ok) {
        await updateUserBalance(username, v.value);
        await logTransaction(username, v.value, "topup", `Voucher: ${v.code}`);
        return new Response("", { status: 302, headers: { "Location": "/user-info?message=Redeemed" } });
    }
    return new Response("", { status: 302, headers: { "Location": "/user-info?error=Failed" } });
}

async function handleTransfer(formData: FormData, username: string): Promise<Response> {
    const to = formData.get("recipient_name")?.toString();
    const amount = parseInt(formData.get("transfer_amount")?.toString() || "0");
    if (!to || amount <= 0) return new Response("", { status: 302, headers: { "Location": "/user-info?error=Invalid" } });
    const res = await transferBalance(username, to, amount);
    return new Response("", { status: 302, headers: { "Location": `/user-info?message=${res==="success"?"Sent":res}` } });
}

async function handleChangePassword(formData: FormData, username: string): Promise<Response> {
    const oldP = formData.get("old_password")?.toString();
    const newP = formData.get("new_password")?.toString();
    if (!oldP || !newP) return new Response("", { status: 302, headers: { "Location": "/user-info?error=Missing" } });
    const res = await changeUserPassword(username, oldP, newP);
    return new Response("", { status: 302, headers: { "Location": `/user-info?message=${res}` } });
}

// --- Main Router ---
async function handler(req:Request): Promise<Response> {
    try {
        const url = new URL(req.url);
        if (req.method === "GET") {
            if (url.pathname === "/login") return renderLoginForm(req);
            if (url.pathname === "/register") return renderRegisterForm(req);
            if (url.pathname === "/logout") return await handleLogout(req);
            
            const token = url.searchParams.get("token");
            if (url.pathname.startsWith("/admin")) {
                if (token !== ADMIN_TOKEN) return renderMessagePage("Auth", "Invalid Token", true);
                if (url.pathname === "/admin/panel") return await renderAdminPanel(token!, url.searchParams.get("message"), req);
                if (url.pathname === "/admin/edit_product") {
                    const p = await getProductById(url.searchParams.get("id")!);
                    return p ? await renderEditProductPage(token!, p.value) : renderMessagePage("404", "Not found", true);
                }
            }

            const user = await authenticateUser(req);
            if (!user) {
                 if(["/", "/dashboard", "/user-info"].includes(url.pathname)) return await handleLogout(req);
            } else {
                 if (url.pathname === "/" || url.pathname === "/dashboard") return await handleDashboard(req, user);
                 if (url.pathname === "/user-info") return await handleUserInfoPage(req, user);
            }
        }
        if (req.method === "POST") {
            const fd = await req.formData();
            if (url.pathname === "/auth") return await handleAuth(fd);
            if (url.pathname === "/doregister") return await handleRegister(fd);
            
            const user = await authenticateUser(req);
            if (user) {
                if (url.pathname === "/buy") return await handleBuy(fd, user.username);
                if (url.pathname === "/redeem_voucher") return await handleRedeemVoucher(fd, user.username);
                if (url.pathname === "/transfer_funds") return await handleTransfer(fd, user.username);
                if (url.pathname === "/change_password") return await handleChangePassword(fd, user.username);
            } else if (["/buy", "/redeem_voucher", "/transfer_funds"].includes(url.pathname)) return await handleLogout(req);

            const token = fd.get("token")?.toString();
            if (token === ADMIN_TOKEN) {
                if (url.pathname === "/admin/add_product") await addProduct(fd.get("name")!.toString(), parseInt(fd.get("price")!.toString()), null, fd.get("imageUrl")!.toString(), fd.get("isDigital")==="on", fd.get("stock")?.toString().split('\n')||[], fd.get("category")!.toString(), fd.get("isSharedStock")==="on");
                else if (url.pathname === "/admin/update_product") await updateProduct(fd.get("productId")!.toString(), fd.get("name")!.toString(), parseInt(fd.get("price")!.toString()), null, fd.get("imageUrl")!.toString(), fd.get("isDigital")==="on", fd.get("stock")?.toString().split('\n')||[], fd.get("category")!.toString(), fd.get("isSharedStock")==="on");
                else if (url.pathname === "/admin/delete_product") await deleteProduct(fd.get("productId")!.toString());
                else if (url.pathname === "/admin/adjust_balance") await updateUserBalance(fd.get("name")!.toString(), parseInt(fd.get("amount")!.toString()));
                else if (url.pathname === "/admin/create_voucher") await generateVoucher(parseInt(fd.get("amount")!.toString()));
                else if (url.pathname === "/admin/reset_password") await resetUserPassword(fd.get("name")!.toString(), fd.get("new_password")!.toString());
                else if (url.pathname === "/admin/toggle_block") await toggleBlockUser(fd.get("name")!.toString());
                else if (url.pathname === "/admin/set_announcement") await setAnnouncement(fd.get("message")!.toString());
                else if (url.pathname === "/admin/set_global_bonus") await setGlobalBonus(parseInt(fd.get("amount")!.toString()));
                else if (url.pathname === "/admin/set_payment_info") await setPaymentInfo({ instructions: fd.get("instructions")!.toString(), telegramUser: fd.get("telegramUser")!.toString(), kpayLogoUrl: "", kpayNumber: fd.get("kpayNumber")!.toString(), kpayName: "", waveLogoUrl: "", waveNumber: fd.get("waveNumber")!.toString(), waveName: "" });
                else if (url.pathname === "/admin/rollback") await handleRefundRollback(fd.get("name")!.toString(), fd.get("timestamp")!.toString(), "Admin");
                else if (url.pathname === "/admin/cleanup") await deleteAllUsersAndRelatedData();
                
                return new Response("", { status: 302, headers: { "Location": `/admin/panel?token=${token}&message=Success` } });
            }
        }
        if (req.method==="GET" && !["/login","/register"].includes(url.pathname)) return new Response("", { status: 302, headers: { "Location": "/login" } });
        return new Response("Not Found", { status: 404 });
    } catch (e) {
        console.error(e);
        return new Response("Server Error", { status: 500 });
    }
}

console.log("Server running...");
Deno.serve(handler);
