// Deno KV Database Setup
const kv = await Deno.openKv(); 

interface User {
    username: string;
    passwordHash: string;
    balance: number; // User's credit/money in Ks
}

// ----------------------------------------------------
// Core KV Functions
// ----------------------------------------------------

/**
 * Retrieves a user's data from the database.
 */
async function getUserByUsername(username: string): Promise<User | null> {
    const key = ["users", username];
    const result = await kv.get<User>(key);
    return result.value;
}

/**
 * Registers a new user with an initial balance of 0.
 */
async function registerUser(username: string, passwordHash: string): Promise<boolean> {
    const user: User = { username, passwordHash, balance: 0 };
    const key = ["users", username];

    // Use check and set to prevent overwriting existing users
    const res = await kv.atomic()
        .check({ key, versionstamp: null })
        .set(key, user)
        .commit();

    return res.ok;
}

// ----------------------------------------------------
// Server and Routing
// ----------------------------------------------------

async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // --- Route: /register (Temporary user creation) ---
    if (url.pathname === "/register") {
        const username = url.searchParams.get("name") || "test_user";
        const password = "password123"; // NOTE: In a real app, use a secure hash here!

        const success = await registerUser(username, password);

        if (success) {
            return new Response(`User '${username}' registered with 0 Ks balance.`, { status: 200 });
        } else {
            return new Response(`User '${username}' already exists.`, { status: 409 });
        }
    }

    // --- Route: /check (Check user balance) ---
    if (url.pathname === "/check") {
        const username = url.searchParams.get("name") || "test_user";
        const user = await getUserByUsername(username);

        if (user) {
            return new Response(`User: ${user.username}, Balance: ${user.balance} Ks`, { status: 200 });
        } else {
            return new Response(`User '${username}' not found.`, { status: 404 });
        }
    }

    // --- Default Route ---
    return new Response("Deno E-Wallet Running. Use /register?name=... or /check?name=...", { status: 200 });
}

// Start the Deno Server
Deno.serve(handler);
