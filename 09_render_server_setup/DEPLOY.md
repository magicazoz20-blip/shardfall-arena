# استضافة الخادم الشبكي

## محليًا
انسخ `.env.example` إلى `.env`، غيّر SESSION_SECRET، ثم نفذ `npm install` و`npm start`.

## استضافة عامة عبر Render
ملف `render.yaml` يجهز خدمة Node.js مجانية لخادم اللعب. افتح رابط النشر واضغط `Apply`:

https://render.com/deploy?repo=https://github.com/magicazoz20-blip/shardfall-arena

سجّل الدخول إلى Render، راجع الخطة المجانية، ثم اضغط `Apply` لإنشاء الخدمة. ينتظر أن يكون العنوان:
`https://shardfall-arena-online-1442049182.onrender.com`

إذا أعطاك Render عنوانًا مختلفًا، أدخله في خانة «عنوان الخادم» في اللعبة. ملف الإعداد يضبط `SESSION_SECRET` تلقائيًا ويسمح بالاتصالات من صفحة اللعبة المنشورة.

## إعداد يدوي بديل
أنشئ خدمة ويب Node.js من هذا المستودع واضبط مجلد الجذر على `server`، وأمر البناء على `npm install`، وأمر التشغيل على `npm start`. عيّن المتغيرات:

- `SESSION_SECRET`: سلسلة سرية عشوائية طويلة وثابتة.
- `CLIENT_ORIGIN`: عنوان صفحة GitHub Pages أو نطاق اللعبة، دون مسارات.
- `PORT`: تديره خدمة الاستضافة عادةً.

الخادم يدعم WebSocket ويجب أن يحصل على نطاق HTTPS/WSS. في اللعبة أدخل عنوان الخادم المنشور في حقل «عنوان الخادم».
