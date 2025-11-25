require('dotenv').config();

const { Telegraf, Markup, Scenes, session } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');

// Express app
const app = express();
app.use(express.json());

// MongoDB ulanish
async function connectDB() {
    try {
        const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://apl:apl00@gamepaymentbot.ffcsj5v.mongodb.net/boter?retryWrites=true&w=majority';
        await mongoose.connect(mongoUri);
        console.log('✅ MongoDB ga muvaffaqiyatli ulandı');
    } catch (error) {
        console.error('MongoDB ulanish xatosi:', error);
        process.exit(1);
    }
}

// User model
const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: String,
    firstName: String,
    lastName: String,
    balance: { type: Number, default: 0 },
    referrals: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    totalEarned: { type: Number, default: 0 },
    joinDate: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Withdraw model
const withdrawSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    cardNumber: { type: String, required: true },
    status: { type: String, default: 'pending', enum: ['pending', 'approved', 'rejected'] },
    createdAt: { type: Date, default: Date.now }
});

const Withdraw = mongoose.model('Withdraw', withdrawSchema);

// Bot token (env dan olish)
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN env variable topilmadi!');
    process.exit(1);
}
const bot = new Telegraf(BOT_TOKEN);

// Bot username (global)
let BOT_USERNAME;

// Adminlar ro'yxati
const ADMINS = [6606638731]; // Admin user ID larni qo'shing

// Referral bonuslar
const REFERRAL_BONUS = {
    inviter: 500, // Taklif qiluvchi uchun
    invited: 250  // Taklif qilinuvchi uchun
};

// Yangi foydalanuvchi qo'shish
async function createUser(ctx) {
    const from = ctx.from;
    const referralId = ctx.startPayload; // /start REFERRAL_ID
    
    try {
        let referredBy = null;
        
        // Agar referral ID bo'lsa
        if (referralId) {
            referredBy = await User.findOne({ userId: parseInt(referralId) });
        }
        
        const user = new User({
            userId: from.id,
            username: from.username,
            firstName: from.first_name,
            lastName: from.last_name,
            referredBy: referredBy ? referredBy._id : null
        });
        
        await user.save();
        
        // Agar referral orqali kelgan bo'lsa, bonus berish
        if (referredBy) {
            // Taklif qiluvchiga bonus
            referredBy.balance += REFERRAL_BONUS.inviter;
            referredBy.totalEarned += REFERRAL_BONUS.inviter;
            referredBy.referrals.push(user._id);
            await referredBy.save();
            
            // Taklif qilinuvchiga bonus
            user.balance += REFERRAL_BONUS.invited;
            user.totalEarned += REFERRAL_BONUS.invited;
            await user.save();
            
            // Taklif qiluvchiga xabar
            try {
                await ctx.telegram.sendMessage(
                    referredBy.userId,
                    `🎉 Tabriklaymiz! Sizning taklif do'stingiz botga qo'shildi va siz ${REFERRAL_BONUS.inviter} so'm bonus oldingiz!`
                );
            } catch (error) {
                console.log('Taklif qiluvchiga xabar yuborishda xato:', error);
            }
        }
        
        return user;
    } catch (error) {
        if (error.code === 11000) {
            // User allaqachon mavjud
            return await User.findOne({ userId: from.id });
        }
        throw error;
    }
}

// Asosiy menyu
function getMainMenu() {
    return Markup.keyboard([
        ['💰 Mening balansim', '💸 Pul chiqarish'],
        ['👥 Taklif qilish', '📊 Statistika'],
        ['🏆 Top reyting', 'ℹ️ Yordam']
    ]).resize();
}

// Admin panel
function getAdminMenu() {
    return Markup.keyboard([
        ['📢 E\'lon yuborish', '📋 Withdraw so\'rovlari'],
        ['📈 Bot statistikasi'],
        ['🔙 Asosiy menyu']
    ]).resize();
}

// Start komandasi
bot.start(async (ctx) => {
    const user = await createUser(ctx);
    
    const welcomeText = `👋 Salom ${user.firstName}!

🤝 Referral botimizga xush kelibsiz!

💰 Har bir taklif qilgan do'stingiz uchun sizga ${REFERRAL_BONUS.inviter} so'm, do'stingizga esa ${REFERRAL_BONUS.invited} so'm bonus beriladi!

👇 Quyidagi menyudan kerakli bo'limni tanlang:`;

    await ctx.reply(welcomeText, getMainMenu());
});

// Mening balansim
bot.hears('💰 Mening balansim', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        return ctx.reply('❌ Foydalanuvchi topilmadi. /start buyrug\'ini yuboring.');
    }
    
    const balanceText = `💳 Sizning balansingiz: ${user.balance} so'm

📈 Jami ishlangan: ${user.totalEarned} so'm
👥 Jami takliflar: ${user.referrals.length} ta

💸 Balansingizni chiqarib olish uchun "💸 Pul chiqarish" bo'limini tanlang.`;
    
    await ctx.reply(balanceText);
});

// Pul chiqarish
bot.hears('💸 Pul chiqarish', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        return ctx.reply('❌ Foydalanuvchi topilmadi. /start buyrug\'ini yuboring.');
    }
    
    if (user.balance < 10000) {
        return ctx.reply(`❌ Balansingiz yetarli emas! Minimal chiqarish miqdori: 10000 so'm\nSizning balans: ${user.balance} so'm`);
    }
    
    ctx.session = ctx.session || {};
    ctx.session.withdrawStep = 'amount';
    ctx.session.userId = ctx.from.id;
    ctx.session.balance = user.balance;
    
    await ctx.reply(`💳 Pul chiqarish so'rovi\n\nJoriy balans: ${user.balance} so'm\n\nMiqdorni kiriting (10000 - ${user.balance} oralig'ida):`);
});

// Taklif qilish
bot.hears('👥 Taklif qilish', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        return ctx.reply('❌ Foydalanuvchi topilmadi. /start buyrug\'ini yuboring.');
    }
    const referralLink = `https://t.me/${BOT_USERNAME}?start=${user.userId}`;
    
    const referralText = `🤝 Do'stlaringizni taklif qiling va pul ishlang!

🔗 Sizning taklif havolangiz:
${referralLink}

📊 Taklif statistikangiz:
👥 Jami takliflar: ${user.referrals.length} ta
💰 Jami ishlangan: ${user.totalEarned} so'm

🎯 Har bir taklif uchun:
• Siz: ${REFERRAL_BONUS.inviter} so'm
• Do'stingiz: ${REFERRAL_BONUS.invited} so'm

📱 Havolani nusxalash uchun pastdagi tugmani bosing:`;
    
    await ctx.reply(referralText, Markup.inlineKeyboard([
        Markup.button.url('📱 Havolani ulashish', `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Bu ajoyib bot! Pul ishlash uchun qo\'shiling!')}`)
    ]));
});

// Statistika
bot.hears('📊 Statistika', async (ctx) => {
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        return ctx.reply('❌ Foydalanuvchi topilmadi. /start buyrug\'ini yuboring.');
    }
    const totalUsers = await User.countDocuments();
    
    const statsText = `📊 Sizning statistikangiz:

👤 Shaxsiy:
• Balans: ${user.balance} so'm
• Jami ishlangan: ${user.totalEarned} so'm
• Takliflar soni: ${user.referrals.length} ta

🌐 Umumiy bot statistikasi:
• Jami foydalanuvchilar: ${totalUsers} ta
• Faol foydalanuvchilar: ${totalUsers} ta`;

    await ctx.reply(statsText);
});

// Top reyting
bot.hears('🏆 Top reyting', async (ctx) => {
    const topUsers = await User.aggregate([
        { $addFields: { referralCount: { $size: "$referrals" } } },
        { $sort: { referralCount: -1 } },
        { $limit: 10 },
        { $project: { firstName: 1, username: 1, referralCount: 1, totalEarned: 1 } }
    ]);
    
    let ratingText = '🏆 TOP 10 - Eng ko\'p taklif qilgan foydalanuvchilar:\n\n';
    
    if (topUsers.length === 0) {
        ratingText += 'Hali hech kim yo\'q.';
    } else {
        topUsers.forEach((user, index) => {
            const name = user.firstName || user.username || 'Foydalanuvchi';
            ratingText += `${index + 1}. ${name} - ${user.referralCount} ta taklif (${user.totalEarned} so'm)\n`;
        });
    }
    
    await ctx.reply(ratingText);
});

// Yordam
bot.hears('ℹ️ Yordam', async (ctx) => {
    const helpText = `ℹ️ Botdan foydalanish bo'yicha ko'rsatma:

💰 Pul ishlash:
1. "👥 Taklif qilish" bo'limiga o'ting
2. Taklif havolangizni oling
3. Do'stlaringizga yuboring
4. Har bir botga qo'shilgan do'stingiz uchun ${REFERRAL_BONUS.inviter} so'm olasiz!

💸 Balansni chiqarish:
• Minimal: 10000 so'm
• "💸 Pul chiqarish" bo'limidan so'rov yuboring
• Admin tasdiqlagach, pul o'tkaziladi

📊 Statistika:
• "📊 Statistika" bo'limida shaxsiy va umumiy statistikani ko'rishingiz mumkin

❓ Savollar bo'lsa: @youradmin (admin username ni o'zgartiring)`;
    
    await ctx.reply(helpText);
});

// Admin komandalari
bot.command('admin', async (ctx) => {
    if (!ADMINS.includes(ctx.from.id)) {
        return ctx.reply('❌ Sizga ruxsat berilmagan!');
    }
    
    await ctx.reply('👨‍💻 Admin panelga xush kelibsiz!', getAdminMenu());
});

// Asosiy menyu (admin uchun)
bot.hears('🔙 Asosiy menyu', async (ctx) => {
    if (!ADMINS.includes(ctx.from.id)) {
        return ctx.reply('❌ Sizga ruxsat berilmagan!');
    }
    
    await ctx.reply('🏠 Asosiy menyu', getMainMenu());
});

// Bot statistikasi
bot.hears('📈 Bot statistikasi', async (ctx) => {
    if (!ADMINS.includes(ctx.from.id)) {
        return ctx.reply('❌ Sizga ruxsat berilmagan!');
    }
    
    const totalUsers = await User.countDocuments();
    const totalReferrals = await User.aggregate([
        { $project: { referralsCount: { $size: "$referrals" } } },
        { $group: { _id: null, total: { $sum: "$referralsCount" } } }
    ]);
    
    const totalBalance = await User.aggregate([
        { $group: { _id: null, total: { $sum: "$balance" } } }
    ]);
    
    const totalEarned = await User.aggregate([
        { $group: { _id: null, total: { $sum: "$totalEarned" } } }
    ]);
    
    const referralsCount = totalReferrals[0] ? totalReferrals[0].total : 0;
    const balanceTotal = totalBalance[0] ? totalBalance[0].total : 0;
    const earnedTotal = totalEarned[0] ? totalEarned[0].total : 0;
    
    const statsText = `📊 Bot statistikasi:

👥 Foydalanuvchilar:
• Jami foydalanuvchilar: ${totalUsers} ta
• Jami takliflar: ${referralsCount} ta

💰 Moliyaviy:
• Jami balanslar: ${balanceTotal} so'm
• Jami ishlangan: ${earnedTotal} so'm
• Jami to'langan: ${earnedTotal - balanceTotal} so'm

📈 O'rtacha ko'rsatkichlar:
• Har bir foydalanuvchi: ${(totalUsers > 0 ? referralsCount / totalUsers : 0).toFixed(1)} ta taklif
• O'rtacha balans: ${(totalUsers > 0 ? balanceTotal / totalUsers : 0).toFixed(0)} so'm`;

    await ctx.reply(statsText, getAdminMenu());
});

// Withdraw so'rovlari (admin)
bot.hears('📋 Withdraw so\'rovlari', async (ctx) => {
    if (!ADMINS.includes(ctx.from.id)) {
        return ctx.reply('❌ Sizga ruxsat berilmagan!');
    }
    
    const requests = await Withdraw.find({ status: 'pending' })
        .populate('user', 'firstName username userId balance')
        .sort({ createdAt: -1 });
    
    if (requests.length === 0) {
        return ctx.reply('📋 Hozircha kutilayotgan so\'rovlar yo\'q.', getAdminMenu());
    }
    
    let text = '📋 Kutilayotgan pul chiqarish so\'rovlari:\n\n';
    requests.forEach((req, i) => {
        const u = req.user;
        text += `${i + 1}. ${u.firstName} (@${u.username || 'yo\'q'})\n`;
        text += `💰 Miqdor: ${req.amount} so'm\n`;
        text += `💳 Karta: **** **** **** ${req.cardNumber.slice(-4)}\n`;
        text += `🆔 ID: ${u.userId}\n`;
        text += `🕐 ${req.createdAt.toLocaleDateString('uz-UZ')}\n\n`;
    });
    
    await ctx.reply(text, getAdminMenu());
});

// E'lon yuborish
const broadcastScene = new Scenes.BaseScene('broadcast');
broadcastScene.enter((ctx) => {
    ctx.reply('📢 E\'lon yuborish rejimi. Xabarni yuboring (matn, rasm, video yoki boshqa media):', 
        Markup.keyboard([['❌ Bekor qilish']]).resize());
});

broadcastScene.on('message', async (ctx) => {
    const text = ctx.message.text;
    if (text === '❌ Bekor qilish') {
        await ctx.reply('E\'lon yuborish bekor qilindi.', getAdminMenu());
        return ctx.scene.leave();
    }
    
    try {
        const users = await User.find({}, 'userId');
        let successCount = 0;
        let failCount = 0;
        
        await ctx.reply(`📤 E'lon ${users.length} ta foydalanuvchiga yuborilmoqda...`);
        
        for (const userDoc of users) {
            try {
                await ctx.telegram.forwardMessage(userDoc.userId, ctx.chat.id, ctx.message.message_id);
                successCount++;
                await new Promise(resolve => setTimeout(resolve, 30));
            } catch (error) {
                console.log(`Foydalanuvchi ${userDoc.userId} ga xabar yuborishda xato:`, error);
                failCount++;
            }
        }
        
        await ctx.reply(
            `✅ E'lon yuborish yakunlandi!\n\n` +
            `✅ Muvaffaqiyatli: ${successCount} ta\n` +
            `❌ Xatolik: ${failCount} ta`,
            getAdminMenu()
        );
        
    } catch (error) {
        console.log('E\'lon yuborishda xato:', error);
        await ctx.reply('❌ E\'lon yuborishda xatolik yuz berdi!', getAdminMenu());
    }
    
    ctx.scene.leave();
});

// Scene ni ro'yxatdan o'tkazish
const stage = new Scenes.Stage([broadcastScene]);
bot.use(session());
bot.use(stage.middleware());

bot.hears('📢 E\'lon yuborish', (ctx) => {
    if (!ADMINS.includes(ctx.from.id)) {
        return ctx.reply('❌ Sizga ruxsat berilmagan!');
    }
    
    ctx.scene.enter('broadcast');
});

// Foydalanuvchi ma'lumotlarini yangilash middleware (eng boshida)
bot.use(async (ctx, next) => {
    if (ctx.from) {
        try {
            await User.findOneAndUpdate(
                { userId: ctx.from.id },
                {
                    username: ctx.from.username,
                    firstName: ctx.from.first_name,
                    lastName: ctx.from.last_name
                },
                { upsert: true }
            );
        } catch (error) {
            console.log('Foydalanuvchi ma\'lumotlarini yangilashda xato:', error);
        }
    }
    await next();
});

// Text handler (withdraw uchun) - session step borligini tekshirish
bot.on('text', async (ctx) => {
    const step = ctx.session?.withdrawStep;
    if (!step) return; // Boshqa textlarni ignore qilish (admin hears oldinroq)
    
    const user = await User.findOne({ userId: ctx.from.id });
    if (!user) {
        return ctx.reply('❌ Foydalanuvchi topilmadi. /start buyrug\'ini yuboring.');
    }
    
    if (step === 'amount') {
        const amount = parseInt(ctx.message.text);
        if (isNaN(amount) || amount < 10000 || amount > user.balance) {
            return ctx.reply(`❌ Noto'g'ri miqdor! 10000 - ${user.balance} oralig'ida kiriting.`);
        }
        
        ctx.session.amount = amount;
        ctx.session.withdrawStep = 'card';
        await ctx.reply('💳 16 xonali karta raqamini kiriting (masalan: 9860000000000000, bo\'shliqsiz):');
        
    } else if (step === 'card') {
        let cardNumber = ctx.message.text.replace(/\s/g, '').replace(/-/g, '');
        if (!/^\d{16}$/.test(cardNumber)) {
            return ctx.reply('❌ Noto\'g\'ri karta raqami! Faqat 16 ta raqam kiriting (bo\'shliqsiz).');
        }
        
        const withdraw = new Withdraw({
            user: user._id,
            amount: ctx.session.amount,
            cardNumber: cardNumber
        });
        await withdraw.save();
        
        // Adminga yuborish
        const keyboard = Markup.inlineKeyboard([
            [
                Markup.button.callback('✅ Tasdiqlash', `approve_${withdraw._id}`),
                Markup.button.callback('❌ Rad etish', `reject_${withdraw._id}`)
            ]
        ]);
        
        for (let adminId of ADMINS) {
            try {
                await ctx.telegram.sendMessage(
                    adminId,
                    `💳 Yangi pul chiqarish so'rovi\n\n` +
                    `👤 Foydalanuvchi: ${user.firstName} ${user.lastName || ''} (@${user.username || 'yo\'q'})\n` +
                    `💰 Miqdor: ${ctx.session.amount} so'm\n` +
                    `💳 Karta: ${cardNumber.slice(0,4)} **** **** ${cardNumber.slice(-4)}\n` +
                    `🆔 User ID: ${user.userId}\n` +
                    `🕐 ${new Date().toLocaleDateString('uz-UZ')}`,
                    keyboard
                );
            } catch (error) {
                console.log('Adminga yuborishda xato:', error);
            }
        }
        
        await ctx.reply('✅ So\'rovingiz muvaffaqiyatli yuborildi! Admin tasdiqlashini kuting.\n\nStatusni "💰 Mening balansim" dan kuzatishingiz mumkin.');
        
        // Session tozalash
        delete ctx.session.withdrawStep;
        delete ctx.session.amount;
        delete ctx.session.balance;
    }
});

// Callback query handler (withdraw tasdiqlash/rad)
bot.on('callback_query', async (ctx) => {
    if (!ADMINS.includes(ctx.from.id)) {
        return ctx.answerCbQuery('❌ Sizga ruxsat yo\'q!');
    }
    
    const data = ctx.callbackQuery.data;
    if (data.startsWith('approve_') || data.startsWith('reject_')) {
        const action = data.startsWith('approve_') ? 'approved' : 'rejected';
        const wid = data.replace('approve_', '').replace('reject_', '');
        
        const withdraw = await Withdraw.findById(wid).populate('user');
        if (!withdraw) {
            return ctx.answerCbQuery('❌ So\'rov topilmadi!');
        }
        
        const user = withdraw.user;
        if (action === 'approved') {
            // Balansni ayirish
            user.balance -= withdraw.amount;
            await user.save();
        }
        
        withdraw.status = action;
        await withdraw.save();
        
        // Foydalanuvchiga xabar
        const statusEmoji = action === 'approved' ? '✅' : '❌';
        const statusText = action === 'approved' ? 
            `Tabriklaymiz! ${withdraw.amount} so'm ${withdraw.cardNumber.slice(0,4)}****${withdraw.cardNumber.slice(-4)} kartasiga o'tkazildi!` :
            `Kechirasiz, so'rovingiz rad etildi. Iltimos, admin bilan bog'laning.`;
        
        try {
            await ctx.telegram.sendMessage(user.userId, `${statusEmoji} ${statusText}`);
        } catch (error) {
            console.log('Foydalanuvchiga xabar yuborishda xato:', error);
        }
        
        await ctx.answerCbQuery(`${action === 'approved' ? 'Tasdiqlandi' : 'Rad etildi'}!`);
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] }); // Tugmalarni olib tashlash
    }
});

// Xatoliklarni qayta ishlash
bot.catch((err, ctx) => {
    console.error(`Bot xatosi:`, err);
    if (ctx) {
        ctx.reply('❌ Botda xatolik yuz berdi. Iltimos, keyinroq urinib ko\'ring.');
    }
});

// Botni ishga tushurish
async function startBot() {
    try {
        await connectDB();
        
        // Bot username olish
        const botInfo = await bot.telegram.getMe();
        BOT_USERNAME = botInfo.username;
        console.log(`✅ Bot username: @${BOT_USERNAME}`);
        
        // Webhook sozlash (Render uchun)
        const PORT = process.env.PORT || 3000;
        const WEBHOOK_URL = `https://boter-x40u.onrender.com/${BOT_TOKEN}`;
        await bot.telegram.setWebhook(WEBHOOK_URL);
        console.log(`✅ Webhook set qilindi: ${WEBHOOK_URL}`);
        
        // Express webhook endpoint
        app.post(`/${BOT_TOKEN}`, (req, res) => {
            bot.handleUpdate(req.body);
            res.sendStatus(200);
        });
        
        // Health check endpoint
        app.get('/', (req, res) => {
            res.send(`Bot ishlamoqda! Username: @${BOT_USERNAME}`);
        });
        
        // Server ishga tushirish
        app.listen(PORT, () => {
            console.log(`✅ Server ${PORT} portda ishga tushdi`);
        });
        
        console.log('✅ Bot muvaffaqiyatli ishga tushdi (webhook rejimi)');
        
        // Graceful shutdown
        process.once('SIGINT', () => {
            bot.stop('SIGINT');
            process.exit(0);
        });
        process.once('SIGTERM', () => {
            bot.stop('SIGTERM');
            process.exit(0);
        });
        
    } catch (error) {
        console.error('Botni ishga tushirishda xato:', error);
        process.exit(1);
    }
}

// Botni ishga tushurish
startBot();

module.exports = { app, bot };
