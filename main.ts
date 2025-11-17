// Deno KV Database Setup
const kv = await Deno.openKv(); 

// --- Configuration and Security ---
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") || "hardcoded_admin_pass"; 
const SESSION_COOKIE_NAME = "session_id";
const MYANMAR_TIMEZONE = "Asia/Yangon";

// NEW: Rate Limiting Configuration
const RATE_LIMIT_WINDOW_MS = 60000; // 60 seconds
const MAX_REQUESTS_PER_WINDOW = 5; // 5 requests per user/IP in 60 seconds

// NEW: Tier Configuration
const TIER_THRESHOLDS = {
    "Bronze": 0,
    "Silver": 50000,   // 50,000 Ks
    "Gold": 200000     // 200,000 Ks
} as const; // const assertion to ensure type safety

// --- Data Structures ---
interface User {
    username: string;
    passwordHash: string; // This will now store the SHA-256 hash
    balance: number;
    isBlocked?: boolean; 
    receivedBonus?: boolean; // To track global bonus
    lifetimeSpend: number | undefined; // NEW | Make undefined possible for migration
    tier: keyof typeof TIER_THRESHOLDS | undefined; // NEW | Make undefined possible for migration
}
interface Transaction {
    type: "topup" | "purchase";
    amount: number;
    timestamp: string; 
    itemName?: string; 
    itemDetails?: string; 
    isRolledBack?: boolean; // Rollback status
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
    isSharedStock: boolean; // NEW: Flag for unlimited stock (Code not removed after purchase)
    stock: string[]; 
    category: string; // Category field
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

// NEW: Tier calculation
function calculateTier(spend: number): User['tier'] {
    if (spend >= TIER_THRESHOLDS.Gold) return "Gold";
    if (spend >= TIER_THRESHOLDS.Silver) return "Silver";
    return "Bronze";
}

// Hashing Utilities (Using native Web Crypto API for simplicity)
async function hashPassword(password: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    
    // Convert Buffer to Hex String
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

async function verifyHash(inputPassword: string, storedHash: string): Promise<boolean> {
    const inputHash = await hashPassword(inputPassword);
    return inputHash === storedHash;
}

// NEW: Rate Limiting Logic
async function checkRateLimit(identifier: string): Promise<boolean> {
    const key = ["rate_limit", identifier];
    const result = await kv.get<number>(key);
    const currentCount = result.value || 0;

    if (currentCount >= MAX_REQUESTS_PER_WINDOW) {
        return false; // Limit exceeded
    }

    // Increment count and set/reset TTL
    await kv.set(key, currentCount + 1, { expireIn: RATE_LIMIT_WINDOW_MS });
    return true; // Request allowed
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

// Function to get sales and user statistics
async function getSalesSummary(): Promise<{ totalUsers: number, totalRevenue: number, totalSales: number }> {
    const allUsersEntries = kv.list<User>({ prefix: ["users"] });
    const allTransactionsEntries = kv.list<Transaction>({ prefix: ["transactions"] });

    let totalUsers = 0;
    let totalRevenue = 0; 
    let totalSales = 0;   

    // 1. Count Total Users
    for await (const entry of allUsersEntries) {
        totalUsers++;
    }

    // 2. Calculate Revenue and Sales
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

// NEW: Update lifetime spend and recalculate tier
async function updateUserSpendAndTier(username: string, spendChange: number): Promise<boolean> {
    const key = ["users", username];
    while (true) {
        const result = await kv.get<User>(key);
        const user = result.value;
        if (!user) return false;

        const currentSpend = user.lifetimeSpend ?? 0; // Use 0 if undefined (for old users)
        const newLifetimeSpend = currentSpend + spendChange;
        
        // Ensure spend never goes negative
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
    
    // FIXED: Initialize lifetimeSpend and tier to ensure they exist
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

async function resetUserPassword(username: string, newPasswordHash: string): Promise<boolean> {
    const key = ["users", username];
    const result = await kv.get<User>(key);
    const user = result.value;
    if (!user) return false; 
    
    // NEW: Hash the new password before storing
    const hashedPassword = await hashPassword(newPasswordHash);
    
    user.passwordHash = hashedPassword;
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

    // 1. Prepare data for logs
    const senderTimestamp = new Date().toISOString();
    // (Add 1ms to avoid key collision)
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

    // 3. (while(true) loop) is correct for race conditions
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
        
        // 4. (FIXED) Include logging in the atomic operation
        const res = await kv.atomic()
            .check(senderResult) // Check if sender data is unchanged
            .check(recipientResult) // Check if recipient data is unchanged
            .set(senderKey, { ...sender, balance: newSenderBalance }) // Deduct from sender
            .set(recipientKey, { ...recipient, balance: newRecipientBalance }) // Add to recipient
            .set(senderLogKey, senderTransaction) // Write sender log
            .set(recipientLogKey, recipientTransaction) // Write recipient log
            .commit();
        
        if (res.ok) {
            // NEW: Update sender's spend and tier (Transfers count as spending)
            await updateUserSpendAndTier(senderUsername, amount); 

            return "success"; 
        }
        // If res.ok is false (race condition), the loop repeats
    }
}


async function logTransaction(username: string, amount: number, type: "topup" | "purchase", itemName?: string, itemDetails?: string): Promise<void> {
    const timestamp = new Date().toISOString(); 
    const key = ["transactions", username, timestamp]; 
    const transaction: Transaction = { type, amount, timestamp, itemName, itemDetails }; 
    await kv.set(key, transaction);
}

// NEW: Optimized getTransactions for pagination (User Info Page)
async function getTransactions(username: string, limit: number, cursor: string | undefined): Promise<{ transactions: Transaction[], nextCursor: string | undefined }> {
    // Reverse order: true means newest transactions first
    const entries = kv.list<Transaction>({ 
        prefix: ["transactions", username],
        limit: limit,
        cursor: cursor,
    }, { 
        reverse: true 
    });

    const transactions: Transaction[] = [];
    let nextCursor: string | undefined = undefined;

    for await (const entry of entries) {
        transactions.push(entry.value);
        if (entries.cursor) {
            nextCursor = entries.cursor;
        }
    }
    
    // NOTE: The last cursor returned by kv.list is the actual next cursor if limit reached
    return { transactions, nextCursor: entries.cursor };
}

// Helper function to get a specific transaction by key parts
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
    
    // Determine refund amount and log name
    const originalAmount = Math.abs(transaction.amount);
    const rollbackAmount = transaction.type === "purchase" ? originalAmount : -originalAmount; 
    const rollbackType = rollbackAmount > 0 ? "topup" : "purchase";
    const rollbackItemName = `ROLLBACK/${transaction.type.toUpperCase()} by Admin ${adminUsername}`;

    // 1. Update User Balance
    const success = await updateUserBalance(username, rollbackAmount);

    if (!success) {
        return `Failed to update user balance. Rollback amount: ${rollbackAmount} Ks. (User may not exist or operation results in negative balance)`;
    }

    // 2. Log the Rollback Transaction
    await logTransaction(username, rollbackAmount, rollbackType, rollbackItemName);

    // NEW: Reverse lifetime spend change (only if it was a purchase)
    if (transaction.type === 'purchase') {
        await updateUserSpendAndTier(username, -originalAmount);
    }

    // 3. Mark the original transaction as rolled back
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

// NEW: Function to get Admin-initiated Top-up/Credit history (Excluding Bonuses and with search)
async function getAdminTopupHistory(searchTerm: string = ''): Promise<Transaction[]> {
    const term = searchTerm.toLowerCase();
    const entries = kv.list<Transaction>({ prefix: ["transactions"] });
    const logs: Transaction[] = [];
    for await (const entry of entries) {
        const t = entry.value;
        
        // Only include Admin Top-Up, Voucher, and Rollbacks (Exclude system bonuses/welcome bonuses)
        const isAdminCredit = t.itemName && 
            (t.itemName.includes('Admin Top-Up') || t.itemName.includes('Voucher:') || t.itemName.includes('ROLLBACK/PURCHASE'));

        if (t.type === 'topup' && isAdminCredit) {
            const username = entry.key[1] as string;
            const displayItemName = `${t.itemName} to ${username}`;
            
            // Apply search filter
            if (term === '' || displayItemName.toLowerCase().includes(term)) {
                logs.push({ ...t, itemName: displayItemName }); 
            }
        }
    }
    // Sort by timestamp descending
    return logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
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
    // NEW: Include isSharedStock
    const product: Product = { id, name, price, salePrice, imageUrl, isDigital, stock: stock || [], category, isSharedStock };
    const key = ["products", id];
    const res = await kv.set(key, product);
    return res.ok;
}

async function updateProduct(id: string, name: string, price: number, salePrice: number | null, imageUrl: string, isDigital: boolean, stock: string[], category: string, isSharedStock: boolean): Promise<boolean> {
    const key = ["products", id];
    // NEW: Include isSharedStock
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
            if (entry.value.receivedBonus) { // Only reset if they already got it
                 entry.value.receivedBonus = false; 
                 mutations.push(kv.set(entry.key, entry.value));
            }
        }
        await Promise.all(mutations);
    }
}


// ----------------------------------------------------
// Authentication Helpers
// ----------------------------------------------------

// NEW: This now uses the verifyHash function
async function verifyPassword(inputPassword: string, storedHash: string): Promise<boolean> {
    // Check if stored hash looks like a full SHA-256 hash (64 hex characters)
    if (storedHash.length === 64 && /^[0-9a-fA-F]{64}$/.test(storedHash)) {
        return await verifyHash(inputPassword, storedHash);
    }
    // Fallback for old plaintext passwords (for migration)
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

// ----------------------------------------------------
// HTML Render Functions (Pages)
// ----------------------------------------------------

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

const globalStyles = `
    @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');
    /* Myanmar Font Stack: Added Pyidaungsu and Myanmar Sans Pro */
    body { 
        font-family: 'Myanmar Sans Pro', 'Pyidaungsu', 'Roboto', -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif; 
        margin: 0; padding: 20px; 
        background-color: #f0f2f5; 
        display: flex; 
        justify-content: center; 
        align-items: center; 
        min-height: 90vh; 
        font-size: 16px; /* Ensure base font size is reasonable */
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
    
    /* Mobile/Responsive Adjustments */
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
        
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
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
    const html = `<!DOCTYPE html><html><head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Register</title>
        
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
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


async function renderAdminPanel(token: string, message: string | null, req: Request): Promise<Response> {
    let messageHtml = "";
    if (message) messageHtml = `<div class="success-msg">${decodeURIComponent(message)}</div>`;

    // --- Fetch Sales Summary ---
    const url = new URL(req.url);
    const historySearchTerm = url.searchParams.get('history_search') || '';
    
    const summary = await getSalesSummary();
    const netFlow = summary.totalRevenue - summary.totalSales; 
    // --- End Sales Summary Fetch ---
    
    const products = await getProducts();
    const productListHtml = products.map(p => `
        <div class="product-item">
            <span>${p.name} (${p.category || 'General'}) ${p.isDigital ? `<strong>(${p.stock.length} left)</strong>` : ''} ${p.salePrice ? `<strong style="color:red;">(Sale)</strong>` : ''}</span>
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
    const pInfo = await getPaymentInfo(); // Get current payment info
    const currentBonus = await getGlobalBonus();
    
    const salesHistory = await getDigitalSalesHistory();
    const salesHistoryHtml = salesHistory.map(s => `
        <div class="voucher-item">
            <span><strong>${s.username}</strong> bought <strong>${s.itemName}</strong></span>
            <span class="voucher-value">${toMyanmarTime(s.timestamp)}</span>
        </div>
    `).join('');

    // --- User Balances Section ---
    const allUsers = await getAllUsers();
    const userBalanceListHtml = allUsers.map(u => `
        <div class="user-balance-item">
            <span class="username">${u.username} ${u.isBlocked ? '(BLOCKED)' : ''}</span>
            <span class="balance-amount">${formatCurrency(u.balance)} Ks</span>
        </div>
    `).join('');
    // --- End User Balances Section ---

    // --- Admin Topup History Section ---
    const adminTopups = await getAdminTopupHistory(historySearchTerm); // Apply search term
    const adminTopupHistoryHtml = adminTopups.map(t => `
        <div class="voucher-item">
            <span><strong>${t.itemName}</strong> <strong>+${formatCurrency(t.amount)} Ks</strong></span>
            <span class="voucher-value">${toMyanmarTime(t.timestamp)}</span>
        </div>
    `).join('');
    // --- End Admin Topup History Section ---


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
            
            /* User Balance & Sales Summary Styles */
            .user-balance-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed #eee; font-size: 1.1em; }
            .user-balance-item:last-child { border-bottom: none; }
            .user-balance-item .username { font-weight: 600; }
            .user-balance-item .balance-amount { color: #28a745; }
            .summary-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                gap: 15px;
                margin-bottom: 25px;
            }
            .summary-card { background: #f8f8f8; padding: 15px; border-radius: 8px; border-left: 5px solid; }
            .summary-card p { margin: 0; font-size: 0.9em; color: #555; }
            .summary-card h3 { margin: 5px 0 0; font-size: 1.5em; font-weight: 700; }
            .card-users { border-left-color: #007bff; }
            .card-revenue { border-left-color: #28a745; }
            .card-sales { border-left-color: #ffc107; }
            .card-netflow { border-left-color: #6610f2; }
            
            /* NEW: Accordion Styles */
            .accordion-header {
                background-color: #007bff;
                color: white;
                padding: 15px;
                cursor: pointer;
                border-radius: 8px;
                margin-top: 10px;
                font-weight: 600;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: background-color 0.3s;
            }
            .accordion-header:hover {
                background-color: #0056b3;
            }
            .accordion-content {
                padding: 15px;
                border: 1px solid #ddd;
                border-top: none;
                border-radius: 0 0 8px 8px;
                display: none; /* Hidden by default */
                overflow: hidden;
            }
            .accordion-header.active {
                border-radius: 8px 8px 0 0;
                background-color: #0056b3;
            }
            .accordion-icon {
                font-size: 1.2em;
                transition: transform 0.3s;
            }
            .accordion-header.active .accordion-icon {
                transform: rotate(90deg);
            }
            .accordion-content > hr { margin: 15px 0; }
            
            /* NEW: Search/Filter for Admin History */
            .admin-history-filter {
                display: flex;
                margin-bottom: 15px;
                gap: 10px;
            }
            .admin-history-filter input {
                flex-grow: 1;
                margin-top: 0;
                width: auto;
            }


            /* Admin Panel Mobile Fix */
            @media (max-width: 600px) {
                .container { max-width: 100%; }
                .admin-history-filter { flex-direction: column; }
                .admin-history-filter input, .admin-history-filter button { width: 100%; }
            }

        </style></head>
        <body><div class="container" style="max-width: 700px;">
            ${messageHtml}

            <div class="accordion-header active" data-target="section1">
                <span>📈 Sales & User Management</span>
                <span class="accordion-icon">▶</span>
            </div>
            <div class="accordion-content" id="section1" style="display: block;">
                <h2>📈 Sales Summary</h2>
                <div class="summary-grid">
                    <div class="summary-card card-users">
                        <p>Total Users</p>
                        <h3>${summary.totalUsers}</h3>
                    </div>
                    <div class="summary-card card-revenue">
                        <p>Total Revenue (Top-ups)</p>
                        <h3>${formatCurrency(summary.totalRevenue)} Ks</h3>
                    </div>
                    <div class="summary-card card-sales">
                        <p>Total Sales (Purchases)</p>
                        <h3>${formatCurrency(summary.totalSales)} Ks</h3>
                    </div>
                    <div class="summary-card card-netflow">
                        <p>Net Balance Flow</p>
                        <h3>${formatCurrency(netFlow)} Ks</h3>
                    </div>
                </div>
                <hr>
                <h2>User Balances (${allUsers.length} Users)</h2>
                <div class="balance-list">
                    ${userBalanceListHtml.length > 0 ? userBalanceListHtml : '<p>No users registered yet.</p>'}
                </div>
            </div>
            
            <div class="accordion-header" data-target="section2">
                <span>⚙️ Site Configuration</span>
                <span class="accordion-icon">▶</span>
            </div>
            <div class="accordion-content" id="section2">
                <h2>Site Announcement (Marquee)</h2>
                <form action="/admin/set_announcement" method="POST"><input type="hidden" name="token" value="${token}"><label>Message (leave empty to remove):</label><input type="text" name="message" value="${currentAnnouncement}"><br><br><button type="submit" class="announcement">Set Announcement</button></form><hr>

                <h2>Global Bonus Event</h2>
                <form action="/admin/set_global_bonus" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <label>Bonus Amount (Set to 0 to disable):</label>
                    <input type="number" name="amount" value="${currentBonus?.isActive ? currentBonus.amount : '0'}" required><br><br>
                    <button type="submit" class="admin">Set Global Bonus</button>
                </form><hr>

                <h2>Set Payment Info</h2>
                <form action="/admin/set_payment_info" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <label>Instructions:</label><textarea name="instructions" rows="3" style="width:95%;">${pInfo?.instructions || 'To buy Voucher Codes or Top-Up, please contact Admin via Telegram.'}</textarea><br><br>
                    <label>Telegram Username (no @):</label><input type="text" name="telegramUser" value="${pInfo?.telegramUser || 'YourTelegramUser'}"><br><br>
                    <label>KPay Logo URL:</label><input type="url" name="kpayLogoUrl" value="${pInfo?.kpayLogoUrl || 'https://i2.qyimage.store:2999/i/2e0ca3029baf42b1'}"><br><br>
                    <label>KPay Number:</label><input type="text" name="kpayNumber" value="${pInfo?.kpayNumber || '09xxxxxxxxx'}"><br><br>
                    <label>KPay Name:</label><input type="text" name="kpayName" value="${pInfo?.kpayName || 'Your KPay Name'}"><br><br>
                    <label>Wave Pay Logo URL:</label><input type="url" name="waveLogoUrl" value="${pInfo?.waveLogoUrl || 'https://i2.qyimage.store:2999/i/c139deae73934177'}"><br><br>
                    <label>Wave Pay Number:</label><input type="text" name="waveNumber" value="${pInfo?.waveNumber || '09xxxxxxxxx'}"><br><br>
                    <label>Wave Pay Name:</label><input type="text" name="waveName" value="${pInfo?.waveName || 'Your Wave Pay Name'}"><br><br>
                    <button type="submit" class="payment">Update Payment Info</button>
                </form>
            </div>

            <div class="accordion-header" data-target="section3">
                <span>🛍️ Product Management</span>
                <span class="accordion-icon">▶</span>
            </div>
            <div class="accordion-content" id="section3">
                <h2>Product List</h2><div class="product-list">${products.length > 0 ? productListHtml : '<p>No products yet.</p>'}</div><hr>
                <h2>Add New Product</h2>
                <form action="/admin/add_product" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <label>Product Name:</label><input type="text" name="name" required><br><br>
                    <label>Category (e.g. VPN, Food, Gift Card):</label><input type="text" name="category" required placeholder="e.g., VPN, Games, Food"><br><br>
                    <label>Image URL (or Emoji):</label><input type="url" name="imageUrl" required><br><br>
                    <label>Full Price (Ks):</label><input type="number" name="price" required><br><br>
                    <label>Sale Price (Ks) (Optional):</label><input type="number" name="sale_price" placeholder="Leave empty for no sale"><br><br>
                    <div class="checkbox-container"><input type="checkbox" id="isDigital" name="isDigital" onchange="document.getElementById('stock-details').style.display = this.checked ? 'block' : 'none';">
                        <label for="isDigital">Is this a Digital Code/Account?</label></div><br>
                    
                    <div class="checkbox-container" style="margin-top: 5px;"><input type="checkbox" id="isSharedStock" name="isSharedStock">
                        <label for="isSharedStock">Is this a Shared/Public (Unlimited) Code?</label></div><br>
                    <div id="stock-details" style="display:none;">
                        <label>Stock Details (One item per line):</label>
                        <textarea name="stock" rows="5" style="width: 95%;"></textarea>
                    </div>
                    <button type="submit" class="product">Add Product</button>
                </form>
            </div>

            <div class="accordion-header" data-target="section4">
                <span>👥 User Tools</span>
                <span class="accordion-icon">▶</span>
            </div>
            <div class="accordion-content" id="section4">
                <h2>Adjust Balance</h2>
                <form action="/admin/adjust_balance" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <label>User Name:</label><input type="text" name="name" required><br><br>
                    <label>Amount (Ks):</label><input type="number" name="amount" required placeholder="e.g., 5000 or -500"><br><br>
                    <button type="submit" class="admin">Adjust Balance</button>
                </form><hr>

                <h2>Reset Password</h2>
                <form action="/admin/reset_password" method="POST"><input type="hidden" name="token" value="${token}"><label>User Name:</label><input type="text" name="name" required><br><br><label>New Password:</label><input type="text" name="new_password" required><br><br><button type="submit" class="reset">Reset Password</button></form><hr>
                
                <h2>Toggle Block Status</h2>
                <form action="/admin/toggle_block" method="POST"><input type="hidden" name="token" value="${token}"><label>User Name:</label><input type="text" name="name" required><br><br><button type="submit" style="background-color:#555;">Toggle Block Status</button></form>
                <hr>

                <h2>Admin Top-up & Credit History</h2>
                <form method="GET" class="admin-history-filter" action="/admin/panel">
                    <input type="hidden" name="token" value="${token}">
                    <input type="text" name="history_search" placeholder="Search user/item..." value="${historySearchTerm}">
                    <button type="submit" class="admin">Search</button>
                </form>
                
                <div class="history-list">
                    ${adminTopupHistoryHtml.length > 0 ? adminTopupHistoryHtml : '<p>No administrative credit movements found matching criteria.</p>'}
                </div>
            </div>

            <div class="accordion-header" data-target="section5">
                <span>🔙 Refund & Vouchers</span>
                <span class="accordion-icon">▶</span>
            </div>
            <div class="accordion-content" id="section5">
                <h2>🔙 Refund/Rollback Transaction</h2>
                <p>Enter Username and Transaction Timestamp (Key) to reverse a transaction.</p>
                <form action="/admin/rollback" method="POST">
                    <input type="hidden" name="token" value="${token}">
                    <label>User Name:</label><input type="text" name="name" required><br><br>
                    <label>Transaction Timestamp (Key):</label><input type="text" name="timestamp" required placeholder="Example: 2025-11-17T04:00:00.000Z"><br><br>
                    <button type="submit" class="reset">Perform Rollback/Refund</button>
                </form><hr>

                <h2>Generate Voucher Code</h2>
                <form action="/admin/create_voucher" method="POST"><input type="hidden" name="token" value="${token}"><label>Voucher Value (Ks):</label><input type="number" name="amount" required><br><br><button type="submit" class="voucher">Generate Code</button></form>
                <div class="voucher-list"><h3>Unused Vouchers:</h3>${vouchers.length > 0 ? voucherListHtml : '<p>No unused vouchers.</p>'}</div><hr>

                <h2>Digital Sales History</h2>
                <div class="history-list">
                    ${salesHistoryHtml.length > 0 ? salesHistoryHtml : '<p>No digital items sold yet.</p>'}
                </div>
            </div>

        </div>
        <script>
            document.querySelectorAll('.accordion-header').forEach(header => {
                header.addEventListener('click', () => {
                    const targetId = header.getAttribute('data-target');
                    const content = document.getElementById(targetId);

                    // Toggle visibility of the target content
                    const isVisible = content.style.display === 'block';
                    content.style.display = isVisible ? 'none' : 'block';
                    header.classList.toggle('active', !isVisible);

                    // Close other open accordions
                    document.querySelectorAll('.accordion-content').forEach(otherContent => {
                        if (otherContent.id !== targetId && otherContent.style.display === 'block') {
                            otherContent.style.display = 'none';
                            document.querySelector(\`.accordion-header[data-target="\${otherContent.id}"]\`).classList.remove('active');
                        }
                    });
                });
            });
        </script>
        </body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}

async function renderEditProductPage(token: string, product: Product): Promise<Response> {
    const stockString = product.stock ? product.stock.join('\n') : '';
    const isSharedChecked = product.isSharedStock ? 'checked' : '';

    const html = `<!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Edit Product</title>

            <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
            <style>${globalStyles} 
                button.product{background-color:#ffc107; color:black;}
                @media (max-width: 600px) {
                    .container { max-width: 100%; }
                }
            </style>
        </head>
        <body><div class="container">
            <h1>Edit Product</h1>
            <form action="/admin/update_product" method="POST">
                <input type="hidden" name="token" value="${token}"><input type="hidden" name="productId" value="${product.id}">
                <label>Product Name:</label><input type="text" name="name" required value="${product.name}"><br><br>
                <label>Category (e.g. VPN, Food, Gift Card):</label><input type="text" name="category" required value="${product.category || 'General'}"><br><br>
                <label>Image URL (or Emoji):</label><input type="url" name="imageUrl" required value="${product.imageUrl}"><br><br>
                <label>Full Price (Ks):</label><input type="number" name="price" required value="${product.price}"><br><br>
                <label>Sale Price (Ks) (Optional):</label><input type="number" name="sale_price" value="${product.salePrice === null ? '' : product.salePrice}" placeholder="Leave empty for no sale"><br><br>
                
                <div class="checkbox-container"><input type="checkbox" id="isDigital" name="isDigital" ${product.isDigital ? 'checked' : ''} onchange="document.getElementById('stock-details').style.display = this.checked ? 'block' : 'none';">
                    <label for="isDigital">Is this a Digital Code/Account?</label></div><br>
                
                <div class="checkbox-container" style="margin-top: 5px;"><input type="checkbox" id="isSharedStock" name="isSharedStock" ${isSharedChecked}>
                    <label for="isSharedStock">Is this a Shared/Public (Unlimited) Code?</label></div><br>
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

    const html = `<!DOCTYPE html><html><head>
        <meta charset="UTF-8">
        <title>${title}</title>
        ${metaRefresh}
        <meta name="viewport" content="width=device-width, initial-scale=1">
        
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>${globalStyles} .container{text-align:center; border-top:5px solid ${borderColor};} .message{font-size:1.2em; color:${isError ? '#dc3545' : '#333'};}</style>
        </head>
        <body><div class="container">
            <h1>${title}</h1>
            <p class="message">${message}</p><br>
            ${isError ? `<a href="${linkHref}">${linkText}</a>` : `<p style='color:#777; font-size:0.9em;'>Redirecting back automatically...</p>`}
        </div></body></html>`;
    
    return new Response(html, { status: isError ? 400 : 200, headers: HTML_HEADERS });
}


async function handleDashboard(req: Request, user: User): Promise<Response> {
    const allProducts = await getProducts();
    const announcement = await getAnnouncement(); 
    
    // 1. Get unique categories
    const categories = Array.from(new Set(allProducts.map(p => p.category || 'General'))).sort();
    
    // 2. Determine selected category from URL
    const url = new URL(req.url); 
    const selectedCategory = url.searchParams.get("category") || 'All';

    // 3. Filter products
    const products = selectedCategory === 'All' 
        ? allProducts 
        : allProducts.filter(p => (p.category || 'General') === selectedCategory);

    // 4. Create Category Filter Menu
    const categoryOptionsHtml = ['All', ...categories].map(cat => 
        `<a href="/dashboard?category=${encodeURIComponent(cat)}" class="category-link ${cat === selectedCategory ? 'active' : ''}">${cat}</a>`
    ).join('');
    
    const announcementHtml = announcement ? `
        <div class="marquee-container">
            <div class="marquee-text">📢 ${announcement}</div>
        </div>
    ` : '';

    const productListHtml = products.map(product => {
        const hasSale = product.salePrice !== null && product.salePrice >= 0;
        const displayPrice = hasSale ? product.salePrice : product.price;
        const isOutOfStock = product.isDigital && (!product.stock || product.isSharedStock === false && product.stock.length === 0);

        const priceHtml = hasSale
            ? `<div class="product-price sale">
                 ${product.salePrice === 0 ? '<strong>FREE</strong>' : `<del>${formatCurrency(product.price)} Ks</del> <strong>${formatCurrency(displayPrice)} Ks</strong>`}
               </div>`
            : `<div class="product-price">${formatCurrency(product.price)} Ks</div>`;
            
        return `
        <div class="product-card ${isOutOfStock ? 'out-of-stock' : ''}">

            ${product.imageUrl.startsWith('http') 
                ? `<img data-src="${product.imageUrl}" alt="${product.name}" class="product-image lazy-load" oncontextmenu="return false;">` 
                : `<div class="product-emoji">${product.imageUrl}</div>`}

            <h3 class="product-name">${product.name}</h3>
            ${priceHtml}
            <form method="POST" action="/buy" style="margin-top: auto;" onsubmit="${isOutOfStock ? 'alert(\'This item is out of stock!\'); return false;' : `return checkBalance('${product.name}', ${displayPrice}, ${user.balance});`}">
                <input type="hidden" name="productId" value="${product.id}">
                <button type="submit" class="buy-btn" ${isOutOfStock ? 'disabled' : ''}>${isOutOfStock ? 'Out of Stock' : 'Buy Now'}</button>
            </form>
        </div>
    `}).join('');
    
    const html = `<!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Shop</title>

        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>${globalStyles}
            .nav-links { display: flex; justify-content: space-between; margin-bottom: 20px; margin-top: -10px; gap: 10px; }
            .nav-links a { display: block; padding: 10px 15px; border-radius: 8px; text-align: center; font-weight: 600; text-decoration: none; }
            .info-btn { background-color: #007bff; color: white; border: 1px solid #007bff; }
            .logout-btn { background-color: #ffffff; color: #007bff; border: 1px solid #007bff; }
            .balance-box { background: linear-gradient(90deg, #007bff, #0056b3); color: white; padding: 20px; border-radius: 12px; margin-bottom: 25px; text-align: center; }
            .balance-label { font-size: 16px; opacity: 0.9; }
            .balance-amount { font-size: 2.5em; font-weight: 700; letter-spacing: 1px; }
            .product-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 15px; }
            /* --- FIXED: Force product card to use Flexbox column layout --- */
            .product-card { 
                background: #fff; border: 1px solid #ddd; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); 
                text-align: center; padding: 15px; 
                display: flex; /* Activate Flexbox */
                flex-direction: column; /* Stack items vertically */
                min-height: 250px; /* Ensure minimum height for uniformity */
            }
            /* ----------------------------------------------------------- */
            .product-image { 
                width: 100%; height: 100px; object-fit: cover; border-radius: 8px;
                opacity: 0; /* Hidden initially for fade-in */
                transition: opacity 0.5s ease-in;
            }
            .product-image.lazy-load {
                background-color: #eee; /* Placeholder color */
                opacity: 1; /* Show placeholder immediately */
            }
            .product-image.loaded {
                opacity: 1;
            }
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

            /* Category Filter Styles */
            .category-filter { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-bottom: 20px; }
            .category-link { 
                padding: 6px 12px; 
                border: 1px solid #007bff; 
                border-radius: 6px; 
                color: #007bff; 
                font-size: 14px; 
                font-weight: 500; 
                text-decoration: none; 
                transition: background-color 0.2s;
            }
            .category-link.active {
                background-color: #007bff;
                color: white;
            }

            /* Mobile Dashboard Adjustments */
            @media (max-width: 600px) {
                .container { max-width: 100%; }
                .product-grid {
                    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); /* 2 columns on small screens */
                }
                .balance-amount { font-size: 2em; }
            }
        </style>
        </head>
        <body><div class="container" style="max-width: 800px;">
            <div class="nav-links">
                <a href="/user-info" class="info-btn">My Info</a>
                <a href="/logout" class="logout-btn">Logout</a>
            </div>
            ${announcementHtml}
            <div class="balance-box">
                <div class="balance-label">Welcome, ${user.username}! **(${user.tier || 'Bronze'})**</div>
                <div class="balance-amount">${formatCurrency(user.balance)} Ks</div>
            </div>
            <h2>🛒 Shop Items:</h2>
            
            <div class="category-filter">
                ${categoryOptionsHtml}
            </div>

            <div class="product-grid">
                ${products.length > 0 ? productListHtml : '<p>No products available in this category yet.</p>'}
            </div>
        </div>
        <script>
            function checkBalance(itemName, price, balance) {
                if (price > 0 && balance < price) { // Price check only if price > 0
                    alert("Insufficient Balance!\\nYou have " + formatCurrency(balance) + " Ks but need " + formatCurrency(price) + " Ks.\\nPlease contact admin for a top-up.");
                    return false; 
                }
                return confirm("Are you sure you want to buy " + itemName + " for " + formatCurrency(price) + " Ks?");
            }
            function formatCurrency(amount) {
                return amount.toLocaleString('en-US');
            }
        </script>

        <script>
            document.addEventListener("DOMContentLoaded", function() {
                const lazyImages = [].slice.call(document.querySelectorAll("img.lazy-load"));
                
                lazyImages.forEach(function(img) {
                    // Copy URL from data-src to the real src
                    img.src = img.dataset.src;
                    
                    // Remove placeholder class and add loaded class for fade-in effect
                    img.onload = () => {
                        img.classList.remove("lazy-load");
                        img.classList.add("loaded");
                    };
                    // Handle load failure (optional: set placeholder)
                    img.onerror = () => {
                         img.classList.remove("lazy-load");
                         img.style.backgroundColor = '#ccc';
                    }
                });
            });
        </script>

        </body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}


async function handleUserInfoPage(req: Request, user: User): Promise<Response> {
    // NEW: Pass limit and cursor to getTransactions
    const url = new URL(req.url);
    const limit = 10;
    const currentCursor = url.searchParams.get('cursor') || undefined;

    const { transactions: allTransactions, nextCursor } = await getTransactions(user.username, limit, currentCursor);
    
    // --- Existing Message Logic ---
    const message = url.searchParams.get("message");
    const error = url.searchParams.get("error");
    const value = url.searchParams.get("value");
    const recipient = url.searchParams.get("recipient");

    // --- Filter Logic (Client-side, since Pagination is implemented at KV layer) ---
    const filterType = url.searchParams.get("filter_type") || 'all';
    const searchTerm = url.searchParams.get("search")?.toLowerCase() || '';
    
    // Note: Filtering is now applied to the 10 fetched transactions, not ALL transactions.
    const filteredTransactions = allTransactions.filter(t => {
        const typeMatch = filterType === 'all' || t.type === filterType;
        const searchMatch = searchTerm === '' || 
                            (t.itemName && t.itemName.toLowerCase().includes(searchTerm)) ||
                            (t.itemDetails && t.itemDetails.toLowerCase().includes(searchTerm));
        return typeMatch && searchMatch;
    });

    // --- Message HTML ---
    let messageHtml = "";
    if (message === "redeem_success") messageHtml = `<div class="success-msg">Success! ${formatCurrency(parseInt(value || "0"))} Ks was added to your balance.</div>`;
    if (message === "transfer_success") messageHtml = `<div class="success-msg">Success! You sent ${formatCurrency(parseInt(value || "0"))} Ks to ${recipient}.</div>`;
    if (error) messageHtml = `<div class="error" style="margin-top: 15px;">${decodeURIComponent(error)}</div>`;

    // --- History HTML ---
    
    // List of purchased digital codes (always shown separately)
    const digitalPurchases = filteredTransactions.filter(t => t.type === 'purchase' && t.itemDetails);
    
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
                    <button class="copy-btn" onclick="copyToClipboard('${codeId}', this, 'Copy')">Copy</button>
                </div>
            </li>
            `;
        }).join('');

    // Filter out digital purchases from the main transaction list
    const nonDigitalTransactions = filteredTransactions.filter(t => !t.itemDetails);
    
    const transactionHistoryItems = nonDigitalTransactions.map(t => {
        const itemText = t.type === 'topup' 
            ? `<strong>${t.itemName || 'Top Up'}</strong> <strong>+${formatCurrency(t.amount)} Ks</strong>`
            : t.itemName.includes('Transfer to') || t.itemName.includes('Transfer from') 
                ? t.itemName 
                : `Bought <strong>${t.itemName || 'an item'}</strong> for <strong>${formatCurrency(Math.abs(t.amount))} Ks</strong>`;
        
        const keyTimestamp = t.timestamp; 
        const sanitizedKeyId = `ts-${keyTimestamp.replace(/[^a-zA-Z0-9]/g, '')}`;
        const status = t.isRolledBack ? `<span style="color:red; font-weight:bold;"> (ROLLEDBACK)</span>` : '';
        const statusColor = t.isRolledBack ? '#dc3545' : t.type === 'topup' ? '#28a745' : '#ffc107';

        // --- UPDATED LOGIC: Only show Copy Key button for un-rolledback PURCAHSE/TRANSFER logs ---
        let copyButtonHtml = '';
        if (t.type === 'purchase' && !t.isRolledBack) { 
             // Show Copy Key button for regular purchases or transfers (which use purchase type)
             copyButtonHtml = `
                <code id="${sanitizedKeyId}" style="font-size: 0.8em; color: #777; display: block; user-select: all;">${keyTimestamp}</code>
                <button class="copy-btn" onclick="copyToClipboard('${sanitizedKeyId}', this, 'Copy Key')">Copy Key</button>
             `;
        } else {
             // For Top-ups or Rolled Back items, just show the time
             copyButtonHtml = `<span class="time">${toMyanmarTime(t.timestamp)}</span>`;
        }
        // --- END UPDATED LOGIC ---

        return `
            <li class="${t.type}" style="border-left-color: ${statusColor};">
                <div style="flex-grow: 1;">
                    ${itemText} ${status}
                </div>
                <div class="actions">
                    ${copyButtonHtml}
                </div>
            </li>
        `;
    }).join('');


    // Get dynamic payment info
    const paymentInfo = await getPaymentInfo();
    let paymentHtml = `<div class="form-box payment-info"><p>Admin has not set up payment info yet.</p></div>`; // Default
    if (paymentInfo) {
        paymentHtml = `
        <div class="form-box payment-info">
            <h2>${paymentInfo.instructions ? 'How to Top Up' : ''}</h2>
            <p style="margin-top:0; color:#555;">${paymentInfo.instructions || ''}</p>
            <div class="payment-list">
                <a href="https://t.me/${paymentInfo.telegramUser}" target="_blank" class="telegram-link">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19.467 1.817a1.68 1.68 0 0 0-1.57-.002L3.58 6.471A1.68 1.68 0 0 0 2.21 7.91v1.314a1.68 1.68 0 0 0 .58 1.258l5.96 4.708a.75.75 0 0 1 .31.623v5.04a.75.75 0 0 0 1.25.59L12 19.333l3.22 2.451a.75.75 0 0 0 1.25-.59v-5.04a.75.75 0 0 1 .31-.623l5.96-4.708a1.68 1.68 0 0 0 .58-1.258V7.91a1.68 1.68 0 0 0-1.37-1.443L19.467 1.817Z" /></svg>
                    <span>@${paymentInfo.telegramUser}</span>
                </a>
                <hr style="border:0; border-top:1px solid #eee; margin: 15px 0;">
                <div class="payment-account">
                    <strong><img src="${paymentInfo.kpayLogoUrl}" class="logo" alt="KPay"></strong>
                    <div class="details">
                        <span class="number">${paymentInfo.kpayNumber}</span>
                        <span class="name">${paymentInfo.kpayName}</span>
                    </div>
                </div>
                <div class="payment-account">
                    <strong><img src="${paymentInfo.waveLogoUrl}" class="logo" alt="WavePay"></strong>
                    <div class="details">
                        <span class="number">${paymentInfo.waveNumber}</span>
                        <span class="name">${paymentInfo.waveName}</span>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    // --- Pagination URL Construction ---
    const currentParams = new URLSearchParams(url.searchParams);
    currentParams.delete('cursor'); 
    currentParams.delete('message');
    currentParams.delete('error');
    
    // Previous Page Button Logic (Complex with KV, disabled for now)
    const prevUrl = '#'; 
    
    // Next Page Button Logic
    let nextUrl = '#';
    if (nextCursor) {
        currentParams.set('cursor', nextCursor);
        nextUrl = `/user-info?${currentParams.toString()}`;
    }


    const html = `
        <!DOCTYPE html><html><head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>My Info</title>
            
        <link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
        <style>${globalStyles}
            /* Profile Header */
            .profile-header { display: flex; align-items: center; margin-bottom: 20px; }
            .avatar { width: 60px; height: 60px; border-radius: 50%; background-color: #eee; margin-right: 15px; display: flex; justify-content: center; align-items: center; overflow: hidden; }
            .avatar svg { width: 32px; height: 32px; color: #aaa; }
            /* FIXED: Alignment */
            .profile-info { display: block; } /* Changed to block */
            .profile-name { font-size: 1.8em; font-weight: 600; color: #333; margin: 0; user-select: all; }
            .copy-btn-small { background: #007bff; color: white; border: none; padding: 5px 10px; font-size: 12px; border-radius: 5px; cursor: pointer; margin-top: 5px; width: auto; }
            
            /* Form Box */
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
            .payment-account { display: grid; grid-template-columns: 80px auto; /* 80px logo */ align-items: center; margin-bottom: 12px; font-size: 1.1em; }
            .payment-account strong { font-weight: 600; color: #333; }
            .payment-account .logo { height: 25px; width: auto; }
            .payment-account .details { display: flex; flex-direction: column; }
            .payment-account .number { font-weight: 600; color: #0056b3; }
            .payment-account .name { font-size: 0.9em; color: #555; }
            .telegram-link { display: flex; align-items: center; font-weight: 600; font-size: 1.1em; }
            .telegram-link svg { width: 24px; height: 24px; margin-right: 8px; color: #0088cc; }

            /* Filter Bar Styles */
            .filter-bar { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; }
            .filter-bar select, .filter-bar input[type="text"] {
                flex-grow: 1;
                padding: 10px;
                border: 1px solid #ddd;
                border-radius: 8px;
                font-size: 14px;
                width: auto;
                margin-top: 0;
            }
            .filter-bar button {
                width: auto;
                padding: 10px 15px;
                background-color: #5bc0de;
            }
            
            /* Mobile adjustment for filter bar */
            @media (max-width: 600px) {
                .filter-bar { flex-direction: column; }
                .filter-bar select, .filter-bar input[type="text"], .filter-bar button { width: 100%; }
            }
        </style></head>
        <body><div class="container">
        
        <div class="profile-header">
            <div class="avatar">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A1.875 1.875 0 0 1 18 22.5H6c-.98 0-1.813-.73-1.93-1.703a1.875 1.875 0 0 1 .03-1.179Z" /></svg>
            </div>
            <div class="profile-info">
                <h1 class="profile-name" id="username-text">${user.username} (${user.tier || 'Bronze'})</h1>
                <button class="copy-btn-small" onclick="copyToClipboard('username-text', this, 'Copy Username')">Copy Username</button>
                <p style="font-size: 0.9em; margin: 5px 0 0; color: #777;">Lifetime Spend: ${formatCurrency(user.lifetimeSpend || 0)} Ks</p>
            </div>
        </div>
        
        ${messageHtml} ${paymentHtml} <div class="form-box">
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
            <h2>Transaction History (${filteredTransactions.length} results)</h2>
            
            <form action="/user-info" method="GET" class="filter-bar">
                <select name="filter_type">
                    <option value="all" ${filterType === 'all' ? 'selected' : ''}>All Transactions</option>
                    <option value="topup" ${filterType === 'topup' ? 'selected' : ''}>Top Ups</option>
                    <option value="purchase" ${filterType === 'purchase' ? 'selected' : ''}>Purchases</option>
                </select>
                <input type="text" name="search" placeholder="Search item name..." value="${searchTerm}">
                <button type="submit">Filter/Search</button>
            </form>

            <div class="history-list">
                ${transactionHistoryItems.length > 0 ? `<ul>${transactionHistoryItems}</ul>` : `<p>No transactions found matching your criteria.</p>`}
            </div>
            
            ${/* Pagination Buttons */''}
            <div style="display: flex; justify-content: flex-end; margin-top: 15px;">
                <a href="${nextUrl}" style="width: 120px; text-align: center;">
                    <button ${nextCursor ? '' : 'disabled'} style="${nextCursor ? '' : 'background-color: #ccc; cursor: not-allowed;'}">Next Page</button>
                </a>
            </div>

        </div>
        
        <a href="/dashboard" style="display:block; text-align:center; margin-top:20px;">Back to Shop</a>
        
        </div>
        <script>
            function copyToClipboard(elementId, buttonElement, originalText = 'Copy') {
                const text = document.getElementById(elementId).innerText;
                navigator.clipboard.writeText(text).then(() => {
                    buttonElement.innerText = "Copied!";
                    setTimeout(() => { buttonElement.innerText = originalText; }, 2000);
                }, (err) => {
                    alert("Failed to copy.");
                });
            }
        </script>

        </body></html>`;
    return new Response(html, { headers: HTML_HEADERS });
}


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
    
    // 1. Get the user WITH versionstamp
    const userKey = ["users", username];
    const userResult = await kv.get<User>(userKey); // <--- This gets the versionstamp
    
    if (!userResult.value) {
        const headers = new Headers();
        headers.set("Location", "/login?error=invalid");
        return new Response("Redirecting...", { status: 302, headers });
    }
    
    const user = userResult.value;

    // 2. Check block / password
    if (user.isBlocked) {
        const headers = new Headers();
        headers.set("Location", "/login?error=blocked");
        return new Response("Redirecting...", { status: 302, headers });
    }
    
    // NEW: Use verifyPassword which handles hashing/fallback
    const passwordMatch = await verifyPassword(password, user.passwordHash);
    
    if (!passwordMatch) {
        const headers = new Headers();
        headers.set("Location", "/login?error=invalid");
        return new Response("Redirecting...", { status: 302, headers });
    }

    // 3. (FIXED) Check for Bonus
    const bonus = await getGlobalBonus();
    if (bonus && bonus.isActive && !user.receivedBonus) {
        const newBalance = user.balance + bonus.amount;
        const updatedUser = { ...user, balance: newBalance, receivedBonus: true };
        
        // 4. Do ONE atomic commit for the bonus
        const res = await kv.atomic()
            .check(userResult) // Use the versionstamp
            .set(userKey, updatedUser)
            .commit();
        
        if (res.ok) {
            await logTransaction(username, bonus.amount, "topup", "Event Bonus");
        }
        // If it fails (race condition), they just log in normally and will get it next time.
    }
    
    // 5. (FIXED) Create session headers manually to overwrite old cookie
    const headers = new Headers();
    headers.set("Location", "/dashboard");

    const encodedSessionId = encodeURIComponent(username); 
    const maxAge = remember ? 2592000 : 3600; // 30 days or 1 hour

    // This single line *overwrites* any existing cookie with the same name/path
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=${encodedSessionId}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
    
    return new Response("Login successful. Redirecting...", { status: 302, headers });
}

async function handleRegister(formData: FormData): Promise<Response> {
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();
    const remember = formData.get("remember") === "on";

    if (!username || !password) return new Response("Missing username or password.", { status: 400 });

    // NEW: Hash the password during registration
    const passwordHash = await hashPassword(password); 
    
    const success = await registerUser(username, passwordHash); // registerUser now handles hash and bonus

    if (success) {
        // (FIXED) Create session headers manually to overwrite old cookie
        const headers = new Headers();
        headers.set("Location", "/dashboard");

        const encodedSessionId = encodeURIComponent(username); 
        const maxAge = remember ? 2592000 : 3600; // 30 days or 1 hour

        // This single line *overwrites* any existing cookie with the same name/path
        headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=${encodedSessionId}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
        
        return new Response("Account created. Logging in...", { status: 302, headers });
    } else {
        const headers = new Headers();
        headers.set("Location", "/register?error=exists");
        return new Response("User exists. Redirecting...", { status: 302, headers });
    }
}

async function handleBuy(formData: FormData, username: string): Promise<Response> {
    
    if (!await checkRateLimit(username)) {
        return renderMessagePage("Rate Limited", "Too many requests. Please wait 60 seconds.", true, "/dashboard");
    }

    const productId = formData.get("productId")?.toString();
    
    if (!productId) {
        return renderMessagePage("Error", "Invalid item ID.", true);
    }
    
    const productResult = await getProductById(productId);
    if (!productResult || !productResult.value) {
        return renderMessagePage("Error", "Item not found.", true);
    }

    const product = productResult.value;
    const price = (product.salePrice !== null && product.salePrice >= 0) ? product.salePrice : product.price; // Get effective price
    const item = product.name;
    let itemDetails: string | undefined = undefined; 

    const user = await getUserByUsername(username);
    
    // NEW LOGIC: Only check balance if price > 0 (supports 0Ks purchases)
    if (price > 0 && (!user || user.balance < price)) {
        const message = `You have ${formatCurrency(user?.balance ?? 0)} Ks but need ${formatCurrency(price)} Ks. Please contact admin for a top-up.`;
        return renderMessagePage("Insufficient Balance", message, true);
    }

    if (product.isDigital) {
        if (!product.stock || product.stock.length === 0) {
            return renderMessagePage("Error", "Sorry, this item is Out of Stock.", true);
        }
        
        const itemToSell = product.stock[0]; 
        let newStock = product.stock;
        
        // NEW SHARED LOGIC: Only remove stock if it's NOT shared stock
        if (!product.isSharedStock) { 
             newStock = product.stock.slice(1); 
        }
        
        const atomicRes = await kv.atomic()
            .check(productResult) 
            .set(["products", product.id], { ...product, stock: newStock })
            .commit();
            
        if (!atomicRes.ok) {
            return renderMessagePage("Error", "Item was just sold! Please try again.", true);
        }
        
        itemDetails = itemToSell; 
    }

    // Spend is always positive amount
    const purchaseAmount = price; 
    
    const success = await updateUserBalance(username, -purchaseAmount); 

    if (success) {
        await logTransaction(username, -purchaseAmount, "purchase", item, itemDetails); 
        
        // NEW: Update lifetime spend and tier
        await updateUserSpendAndTier(username, purchaseAmount);

        const newBalance = (await getUserByUsername(username))?.balance ?? 0;
        
        let detailsMessage = "";
        let reminderMessage = "";

        if (itemDetails) {
            detailsMessage = `<br><br>Your purchased item details:<br><strong style="font-size: 1.2em; color: #d63384;">${itemDetails}</strong>`;
            reminderMessage = "<br><br><small>This page will auto-redirect. You can view this code again in your 'My Info' page.</small>";
        }
        
        const message = `You bought <strong>${item}</strong> for ${formatCurrency(purchaseAmount)} Ks.<br>Your new balance is <strong>${formatCurrency(newBalance)} Ks</strong>.${detailsMessage}${reminderMessage}`;
        
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

    // NOTE: Admin adjustments do NOT affect lifetimeSpend/Tier calculation

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
    const category = formData.get("category")?.toString() || 'General';
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;
    const salePriceStr = formData.get("sale_price")?.toString();
    const salePrice = (salePriceStr && parseInt(salePriceStr) >= 0) ? parseInt(salePriceStr) : null;
    const imageUrl = formData.get("imageUrl")?.toString();
    const token = formData.get("token")?.toString();
    const isDigital = formData.get("isDigital") === "on";
    const isSharedStock = formData.get("isSharedStock") === "on"; // NEW
    const stockString = formData.get("stock")?.toString() || "";
    const stock = isDigital ? stockString.split('\n').filter(s => s.trim() !== '') : [];
    
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!name || isNaN(price) || price < 0 || !imageUrl) {
        return renderMessagePage("Error", "Missing name, price, or image URL.", true, adminBackLink);
    }
    
    await addProduct(name, price, salePrice, imageUrl, isDigital, stock, category, isSharedStock);
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent("Product added!")}`);
    return new Response("Redirecting...", { status: 302, headers });
}

async function handleUpdateProduct(formData: FormData): Promise<Response> {
    const productId = formData.get("productId")?.toString();
    const name = formData.get("name")?.toString();
    const category = formData.get("category")?.toString() || 'General';
    const priceStr = formData.get("price")?.toString();
    const price = priceStr ? parseInt(priceStr) : NaN;
    
    const salePriceStr = formData.get("sale_price")?.toString();
    const salePrice = (salePriceStr && !isNaN(parseInt(salePriceStr))) ? parseInt(salePriceStr) : null; 
    
    const imageUrl = formData.get("imageUrl")?.toString();
    const token = formData.get("token")?.toString();
    const isDigital = formData.get("isDigital") === "on";
    const isSharedStock = formData.get("isSharedStock") === "on"; // NEW
    const stockString = formData.get("stock")?.toString() || "";
    const stock = isDigital ? stockString.split('\n').filter(s => s.trim() !== '') : [];
    
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!productId || !name || isNaN(price) || price < 0 || !imageUrl) { 
        return renderMessagePage("Error", "Missing data for update or Price/Sale Price is invalid.", true, adminBackLink);
    }
    
    // Pass isSharedStock to updateProduct
    const product: Product = { id: productId, name, price, salePrice, imageUrl, isDigital, stock, category, isSharedStock };
    await kv.set(["products", productId], product);
    
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
        headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent("Password reset successfully! (New password is now hashed)")}`);
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

async function handleAdminRollback(formData: FormData, adminUsername: string): Promise<Response> {
    const username = formData.get("name")?.toString();
    const timestamp = formData.get("timestamp")?.toString();
    const token = formData.get("token")?.toString();
    const adminBackLink = `/admin/panel?token=${token}`;

    if (!username || !timestamp) {
        return renderMessagePage("Error", "Missing username or timestamp.", true, adminBackLink);
    }
    
    const message = await handleRefundRollback(username, timestamp, adminUsername);

    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent(message)}`);
    return new Response("Redirecting...", { status: 302, headers });
}


async function handleRedeemVoucher(formData: FormData, username: string): Promise<Response> {
    if (!await checkRateLimit(username)) {
        return renderMessagePage("Rate Limited", "Too many requests. Please wait 60 seconds.", true, "/user-info");
    }

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
    
    // NOTE: Voucher redemption does not count towards lifetime spend (revenue)

    headers.set("Location", `/user-info?message=redeem_success&value=${voucher.value}`);
    return new Response("Redirecting...", { status: 302, headers });
}

async function handleTransfer(formData: FormData, username: string): Promise<Response> {
    if (!await checkRateLimit(username)) {
        return renderMessagePage("Rate Limited", "Too many requests. Please wait 60 seconds.", true, "/user-info");
    }

    const recipientName = formData.get("recipient_name")?.toString();
    const amountStr = formData.get("transfer_amount")?.toString();
    const amount = amountStr ? parseInt(amountStr) : NaN;
    
    const headers = new Headers();
    headers.set("Location", "/user-info"); 

    if (!recipientName || isNaN(amount) || amount <= 0) {
        headers.set("Location", `/user-info?error=${encodeURIComponent("Invalid name or amount.")}`);
        return new Response("Redirecting...", { status: 302, headers });
    }

    // This function is now fully atomic and updates lifetime spend
    const result = await transferBalance(username, recipientName, amount);

    if (result === "success") {
        // (FIXED!) We must encode the recipientName in case it has spaces or special characters
        headers.set("Location", `/user-info?message=transfer_success&value=${amount}&recipient=${encodeURIComponent(recipientName)}`);
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

async function handleSetPaymentInfo(formData: FormData): Promise<Response> {
    const token = formData.get("token")?.toString();
    const info: PaymentInfo = {
        instructions: formData.get("instructions")?.toString() || "",
        telegramUser: formData.get("telegramUser")?.toString() || "",
        kpayLogoUrl: formData.get("kpayLogoUrl")?.toString() || "",
        kpayNumber: formData.get("kpayNumber")?.toString() || "",
        kpayName: formData.get("kpayName")?.toString() || "",
        waveLogoUrl: formData.get("waveLogoUrl")?.toString() || "",
        waveNumber: formData.get("waveNumber")?.toString() || "",
        waveName: formData.get("waveName")?.toString() || "",
    };

    await setPaymentInfo(info);
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent("Payment info updated!")}`);
    return new Response("Redirecting...", { status: 302, headers });
}

async function handleSetGlobalBonus(formData: FormData): Promise<Response> {
    const amountStr = formData.get("amount")?.toString();
    const amount = amountStr ? parseInt(amountStr) : NaN;
    const token = formData.get("token")?.toString();
    
    if (isNaN(amount) || amount < 0) {
        return renderMessagePage("Error", "Invalid amount.", true, `/admin/panel?token=${token}`);
    }

    await setGlobalBonus(amount);
    const message = amount > 0 ? `Global Bonus set to ${amount} Ks!` : "Global Bonus disabled.";
    
    const headers = new Headers();
    headers.set("Location", `/admin/panel?token=${token}&message=${encodeURIComponent(message)}`);
    return new Response("Redirecting...", { status: 302, headers });
}

function handleLogout(): Response {
    const headers = new Headers();
    headers.set("Location", "/login");
    // (FIXED) Must match ALL attributes of the cookie to delete it, especially SameSite
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=deleted; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`); 
    return new Response("Logged out. Redirecting...", { status: 302, headers });
}

// ----------------------------------------------------
// Main Server Router
// ----------------------------------------------------

async function authenticateUser(req: Request): Promise<User | null> {
    const username = getUsernameFromCookie(req);
    if (!username) return null;

    const userKey = ["users", username];
    const userResult = await kv.get<User>(userKey);
    if (!userResult.value) return null;

    let user = userResult.value;
    if (user.isBlocked) return null;

    // --- CHECK FOR GLOBAL BONUS ON EVERY PAGE LOAD ---
    const bonus = await getGlobalBonus();
    if (bonus && bonus.isActive && !user.receivedBonus) {
        const newBalance = user.balance + bonus.amount;
        const updatedUser = { ...user, balance: newBalance, receivedBonus: true };
        
        const res = await kv.atomic()
            .check(userResult) // Use the versionstamp
            .set(userKey, updatedUser)
            .commit();
        
        if (res.ok) {
            await logTransaction(username, bonus.amount, "topup", "Event Bonus");
            return updatedUser; // Return the NEW user object
        }
    }
    // --- END BONUS CHECK ---

    return user; // Return original user if no bonus
}


async function handler(req:Request): Promise<Response> {
    try { // Global error catcher
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
                return await renderAdminPanel(token, message, req); 
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
            const user = await authenticateUser(req); // This now handles the bonus check
            if (!user) {
                // If user is not authenticated (or blocked), redirect to login
                // Only redirect to logout if accessing protected routes
                if(pathname === "/" || pathname === "/dashboard" || pathname === "/user-info") {
                    return handleLogout();
                }
            } else {
                 // User is authenticated
                 if (pathname === "/" || pathname === "/dashboard") return await handleDashboard(req, user);
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
                if (pathname === "/redeem_voucher") return await handleRedeemVoucher(formData, user.username); 
                if (pathname === "/transfer_funds") return await handleTransfer(formData, user.username); 
            } else if (pathname === "/buy" || pathname === "/redeem_voucher" || pathname === "/transfer_funds") {
                return handleLogout(); // Not logged in or blocked, redirect
            }

            // Admin POST (Protected)
            const token = formData.get("token")?.toString();
            const adminUser = "Admin"; // Default name for rollback log
            if (token !== ADMIN_TOKEN) {
                return renderMessagePage("Error", "Unauthorized: Invalid Token.", true);
            }

            if (pathname === "/admin/adjust_balance") return await handleAdminAdjustBalance(formData);
            if (pathname === "/admin/add_product") return await handleAddProduct(formData);
            if (pathname === "/admin/update_product") return await handleUpdateProduct(formData);
            if (pathname === "/admin/delete_product") return await handleDeleteProduct(formData);
            if (pathname === "/admin/reset_password") return await handleResetPassword(formData); 
            if (pathname === "/admin/create_voucher") return await handleCreateVoucher(formData); 
            if (pathname === "/admin/set_announcement") return await handleSetAnnouncement(formData); 
            if (pathname === "/admin/toggle_block") return await handleToggleBlock(formData);
            if (pathname === "/admin/set_payment_info") return await handleSetPaymentInfo(formData); 
            if (pathname === "/admin/set_global_bonus") return await handleSetGlobalBonus(formData); 
            if (pathname === "/admin/rollback") return await handleAdminRollback(formData, adminUser);
        }

        // --- Default Route (Redirect all other requests to login) ---
        // Only redirect if the path is not a recognized public path
        if (req.method === "GET" && pathname !== "/login" && pathname !== "/register") {
             const headers = new Headers();
             headers.set("Location", "/login");
             return new Response("Redirecting to /login...", { status: 302, headers });
        }
        
        // For any other unhandled case (e.g. PUT, DELETE)
        return new Response("Not Found", { status: 404 });

    } catch (err) {
        // Global error catcher
        console.error("Unhandled Server Error:", err);
        return renderMessagePage("Internal Server Error", `An unexpected error occurred: ${err.message}`, true, "/dashboard");
    }
}

// Start the Deno Server
console.log("Server starting...");
Deno.serve(handler);
