// src/index.js
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './db/schema.js';
import { eq, desc } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createClient } from '@supabase/supabase-js';
import { serveStatic } from '@hono/node-server/serve-static';

// Load ENV
if (process.env.NODE_ENV !== 'production') {
    process.loadEnvFile();
}

// Setup koneksi
const client = postgres(process.env.DATABASE_URL);
const db = drizzle(client, { schema });
const supabase = createClient(
    process.env.SUPABASE_URL, 
    process.env.SUPABASE_KEY
);

const app = new Hono();
app.use('/*', cors());
app.use('/*', serveStatic({ root: './public' }));

// --- API REGISTER (Daftar Akun Baru) ---
app.post('/api/register', async (c) => {
    try {
        const { username, password } = await c.req.json();

        // 1. Cek apakah username sudah ada
        const existingUser = await db.query.users.findFirst({
            where: eq(schema.users.username, username)
        });

        if (existingUser) {
            return c.json({ success: false, message: 'Username sudah digunakan' }, 400);
        }

        // 2. Hash password sebelum simpan
        const salt = bcrypt.genSaltSync(10);
        const hashedPassword = bcrypt.hashSync(password, salt);

        // 3. Simpan user baru ke database
        await db.insert(schema.users).values({
            username,
            password: hashedPassword,
            role: 'admin' // Default sebagai admin sesuai kebutuhan toko
        });

        return c.json({ success: true, message: 'Registrasi Berhasil! Silakan Login.' });
    } catch (e) {
        return c.json({ success: false, message: 'Gagal daftar: ' + e.message }, 500);
    }
});

// API Login (Masuk)
app.post('/api/login', async (c) => {
    const { username, password } = await c.req.json();

    const user = await db.query.users.findFirst({
        where: eq(schema.users.username, username)
    });

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return c.json({ success: false, message: 'Login Gagal' }, 401);
    }

    const token = jwt.sign(
        { id: user.id, role: user.role },
        process.env.JWT_SECRET, 
        { expiresIn: '1d' }
    );
    return c.json({ success: true, token });
});

// Middleware Auth
const authMiddleware = async (c, nex) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) return c.json({ message: 'Unauthorized' }, 401);
    try {
        const token = authHeader.split(' ')[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        c.set('user', payload);
        await nex();
    } catch (e) {
        return c.json({ message: 'Invalid Token' }, 403);
    }
};

// API Upload Produk (Admin Only)
app.post('/api/products', authMiddleware, async (c) => {
    try {
        const body = await c.req.parseBody();
        const imageFile = body['image'];

        if (!imageFile || !(imageFile instanceof File)) {
            return c.json({ success: false, message: 'Gambar Wajib!' }, 400);
        }

        const fileName = `prod_${Date.now()}_${imageFile.name.replace(/\s/g, '_')}`;
        const arrayBuffer = new Uint8Array(await imageFile.arrayBuffer()); 

        const { error: uploadError } = await supabase.storage
            .from('products')
            .upload(fileName, arrayBuffer, { contentType: imageFile.type });

        if (uploadError) throw uploadError;

        const { data } = supabase.storage.from('products').getPublicUrl(fileName);
        const imageUrl = data.publicUrl;

        await db.insert(schema.products).values({
            name: body['name'],
            description: body['description'],
            price: body['price'],
            stock: parseInt(body['stock']),
            categoryId: parseInt(body['categoryId']),
            imageUrl: imageUrl
        });
        return c.json({ success: true, message: 'Produk Tersimpan', imageUrl });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 500);
    }
});

// API List Produk (Public)
app.get('/api/products', async (c) => {
    const data = await db.select().from(schema.products).orderBy(desc(schema.products.id));
    return c.json({ success: true, data });
});

// API Checkout (Public)
app.post('/api/orders', async (c) => {
    const { customerName, address, items } = await c.req.json();
    try {
        const result = await db.transaction(async (tx) => {
            let total = 0;

            const [newOrder] = await tx.insert(schema.orders).values({
                customerName, address, totalAmount: "0", status: 'pending'
            }).returning();

            for (const item of items) {
                const product = await tx.query.products.findFirst({
                    where: eq(schema.products.id, item.productId)
                });

                if (!product || product.stock < item.quantity) {
                    throw new Error(`Stok ${product?.name || 'Produk'} tidak mencukupi!`);
                }

                // Perbaikan: Ambil harga langsung dari product.price
                const itemPrice = parseFloat(product.price);
                total += (itemPrice * item.quantity);

                await tx.insert(schema.orderItems).values({
                    orderId: newOrder.id,
                    productId: item.productId,
                    quantity: item.quantity,
                    priceAtTime: product.price
                });

                await tx.update(schema.products)
                    .set({ stock: product.stock - item.quantity })
                    .where(eq(schema.products.id, item.productId));
            }

            await tx.update(schema.orders)
                .set({ totalAmount: total.toString() })
                .where(eq(schema.orders.id, newOrder.id));

            return { orderId: newOrder.id, total };
        });

        return c.json({ success: true, ...result });
    } catch (e) {
        return c.json({ success: false, message: e.message }, 400);
    }
});


const port = 3000;
console.log(`🚀 Server running at http://localhost:${port}`);
serve({ fetch: app.fetch, port });

export default app;