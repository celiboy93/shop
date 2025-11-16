// Deno KV Database Setup
const kv = await Deno.openKv(); 

// --- User Data Structure ---
interface User {
    username: string;
    passwordHash: string; // Storing password (or hash)
    balance: number; 
}

// Global variable for a basic session ID (for simplicity)
const SESSION_COOKIE_NAME = "session_id";

// ----------------------------------------------------
// Core KV Functions (Updated with a function to update balance later)
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

// NOTE: This is a simplified password check. Not secure for production!
function verifyPassword(inputPassword: string, storedHash: string): boolean {
    // In a real app: return bcrypt.compareSync(inputPassword, storedHash);
    return inputPassword === storedHash;
}

// ----------------------------------------------------
// Authentication Handlers
// ----------------------------------------------------

// 1. Login Form Display
function renderLoginForm(): Response {
    const html = `
        <!DOCTYPE html>
        <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Login</title>
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
            <p>Test User: ko_aung / password123</p>
        </body>
        </html>
    `;
    return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// 2. Authentication Processor
async function handleAuth(req: Request): Promise<Response> {
    // Get form data (using simple URLSearchParams for simplicity)
    const formData = await req.formData();
    const username = formData.get("username")?.toString();
    const password = formData.get("password")?.toString();

    if (!username || !password) {
        return new Response("Missing username or password.", { status: 400 });
    }

    const user = await getUserByUsername(username);

    if (!user || !verifyPassword(password, user.passwordHash)) {
        return new Response("Invalid username or password.", { status: 401 });
    }

    // --- SUCCESS: Set a session cookie ---
    // For simplicity, we use the username as the session ID (not secure!)
    const sessionId = username; 
    
    // Redirect to the dashboard
    const headers = new Headers();
    headers.set("Location", "/dashboard");
    // Set cookie: Key=sessionId; Value=username; Path=/; Max-Age=3600 (1 hour)
    headers.set("Set-Cookie", `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; Max-Age=3600; HttpOnly`);

    return new Response("Login successful. Redirecting...", { status: 302, headers });
}


// ----------------------------------------------------
// Server and Routing
// ----------------------------------------------------

async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // --- Route: /login (Display form) ---
    if (url.pathname === "/login") {
        return renderLoginForm();
    }
    
    // --- Route: /auth (Process form submission) ---
    if (url.pathname === "/auth" && req.method === "POST") {
        return handleAuth(req);
    }
    
    // --- Route: /dashboard (Requires authentication/cookie check) ---
    if (url.pathname === "/dashboard") {
        // --- Authentication Check ---
        const cookieHeader = req.headers.get("Cookie");
        // NOTE: In a real app, you would check this sessionId against KV to see if it's valid.
        if (!cookieHeader || !cookieHeader.includes(SESSION_COOKIE_NAME)) {
            // No cookie found, redirect to login
            const headers = new Headers();
            headers.set("Location", "/login");
            return new Response("Unauthorized. Redirecting to login.", { status: 302, headers });
        }
        
        // Find username from cookie (simplified)
        const username = cookieHeader.split(`${SESSION_COOKIE_NAME}=`)[1].split(';')[0];
        const user = await getUserByUsername(username);

        if (user) {
            return new Response(`Welcome, ${user.username}! Your balance is ${user.balance} Ks. (Login Successful)`, { status: 200 });
        } else {
            return new Response("Invalid Session.", { status: 401 });
        }
    }


    // --- Other Routes (Registration, Balance Check, etc. from previous code) ---
    if (url.pathname === "/register") { /* (Registration logic from before) */ }
    if (url.pathname === "/check") { /* (Check logic from before) */ }

    // --- Default Route ---
    return new Response("Welcome to Deno E-Wallet. Go to /login", { status: 200 });
}

Deno.serve(handler);
