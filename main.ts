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
            .set(senderLogKey, senderTransaction)
            .set(recipientLogKey, recipientTransaction)
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

async function verifyPassword(inputPassword: string, storedHash: string): Promise<boolean> {
    if (storedHash.length === 64 && /^[0-9a-fA-F]{64}$/.test(storedHash)) {
        return await verifyHash(inputPassword, storedHash);
    }
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


async function handler(req:Request): Promise<Response> {
    try { 
        const url = new URL(req.url);
        const pathname = url.pathname;
        
        let identifier: string;
        const authUsername = getUsernameFromCookie(req);
        
        if (authUsername) {
            identifier = authUsername;
        } else {
            // FIX: Using static string as fallback identifier for rate limiting unauthenticated users
            identifier = "unauthenticated_ip_fallback"; 
        }


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
            const user = await authenticateUser(req);
            if (!user) {
                if(pathname === "/" || pathname === "/dashboard" || pathname === "/user-info") {
                    return handleLogout();
                }
            } else {
                 if (pathname === "/" || pathname === "/dashboard") return await handleDashboard(req, user);
                 if (pathname === "/user-info") return await handleUserInfoPage(req, user);
            }
        }
        
        // --- Handle POST requests ---
        if (req.method === "POST") {
            const formData = await req.formData(); 

            // Public POST
            if (pathname === "/auth") return await handleAuth(formData);
            if (pathname === "/doregister") return await handleRegister(formData);

            // User 'Buy' & 'Redeem' POST (Protected & Rate Limited)
            const user = await authenticateUser(req); 
            if (user) {
                if (pathname === "/buy") return await handleBuy(formData, user.username);
                if (pathname === "/redeem_voucher") return await handleRedeemVoucher(formData, user.username); 
                if (pathname === "/transfer_funds") return await handleTransfer(formData, user.username); 
            } else if (pathname === "/buy" || pathname === "/redeem_voucher" || pathname === "/transfer_funds") {
                return handleLogout(); 
            }

            // Admin POST (Protected)
            const token = formData.get("token")?.toString();
            const adminUser = "Admin"; 
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
            if (pathname === "/admin/cleanup") return await handleAdminCleanup(formData);
        }

        // --- Default Route ---
        if (req.method === "GET" && pathname !== "/login" && pathname !== "/register") {
             const headers = new Headers();
             headers.set("Location", "/login");
             return new Response("Redirecting to /login...", { status: 302, headers });
        }
        
        return new Response("Not Found", { status: 404 });

    } catch (err) {
        console.error("Unhandled Server Error:", err);
        return renderMessagePage("Internal Server Error", `An unexpected error occurred: ${err.message}`, true, "/dashboard");
    }
}

// Start the Deno Server
console.log("Server starting...");
Deno.serve(handler);
