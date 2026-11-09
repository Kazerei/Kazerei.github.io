const express = require('express');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https'); // 追加
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '15mb' })); // 画像データ受け取り用
app.use(cors());

const PORT = process.env.PORT || 3000;
const GAS_URL = process.env.GAS_URL;

// 🟣 同じフォルダ内にあるHTMLや画像などの静的ファイルを配信する設定
app.use(express.static(path.join(__dirname)));

// 🟣 スリープ防止用：14分おきに自分自身へPingを送信
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || 'https://kazerei-github-io.onrender.com'; // 自分のRenderのURLに書き換えてもOKです
setInterval(() => {
  if (RENDER_URL.includes('onrender.com')) {
    https.get(RENDER_URL, (res) => {
      console.log(`Keep-Alive ping sent, status: ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('Keep-Alive ping error:', err.message);
    });
  }
}, 14 * 60 * 1000);

// SHA-256 ハッシュ化関数
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// 1. スプレッドシートからプレイヤーデータを取得するエンドポイント（詳細ログ出力版）
app.get('/api/players', async (req, res) => {
  try {
    console.log("Fetching from GAS URL:", GAS_URL + "?action=getPlayers");
    const gasResponse = await fetch(GAS_URL + "?action=getPlayers", {
      method: 'GET'
    });
    
    const textData = await gasResponse.text(); // 一度テキストとして受け取る
    console.log("GAS Response Raw Text (First 200 chars):", textData.substring(0, 200));

    const data = JSON.parse(textData);
    res.json(data);
  } catch (error) {
    console.error('Detailed Failed to fetch players from GAS:', error);
    res.status(500).json({ status: 'error', message: 'Failed to fetch players: ' + error.message });
  }
});

// 2. 新規登録エンドポイント（画像AI検証 ＋ パスワード保存）
app.post('/api/register', async (req, res) => {
  try {
    const { mcid, password, imageBase64, mimeType } = req.body;

    if (!mcid || !password || !imageBase64) {
      return res.status(400).json({ status: 'error', message: '必須パラメータが不足しています。' });
    }

    const modelNames = [
      'gemini-3.5-flash-lite',
      'gemini-3.6-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.6-flash'
    ];

    const apiKeys = [
      process.env.GEMINI_API_1,
      process.env.GEMINI_API_2
    ].filter(Boolean);

    if (apiKeys.length === 0) {
      return res.status(500).json({ status: 'error', message: 'Gemini API keys are not configured.' });
    }

    let aiPassed = false;
    let aiErrorMsg = '';

    const imagePart = {
      inlineData: {
        data: imageBase64.replace(/^data:image\/\w+;base64,/, ''),
        mimeType: mimeType || 'image/jpeg'
      }
    };

    const prompt = `
      あなたはマインクラフトのサーバー運営者です。送られた画像が「本人のマインクラフトのプレイ画面、または本人確認用の正当なスクリーンショット」であるかを判定してください。
      他人の拾い画、無関係な画像、テキストが全くない真っ黒な画像、または不適切と判断される画像の場合は不合格にしてください。
      回答は必ず以下のJSONフォーマットのみで行ってください（Markdownのバッククォートなどは使わず純粋なJSON文字列で）。
      {"result": "pass"} または {"result": "fail", "reason": "理由"}
    `;

    for (let keyIdx = 0; keyIdx < apiKeys.length; keyIdx++) {
      const currentApiKey = apiKeys[keyIdx];
      const genAI = new GoogleGenerativeAI(currentApiKey);

      for (let modelIdx = 0; modelIdx < modelNames.length; modelIdx++) {
        const modelName = modelNames[modelIdx];
        try {
          console.log(`Trying API Key [${keyIdx + 1}] with model: ${modelName}`);
          const model = genAI.getGenerativeModel({ model: modelName });

          const result = await model.generateContent([prompt, imagePart]);
          const responseText = await result.response.text();
          
          const cleanJsonStr = responseText.replace(/```json|```/g, '').trim();
          const jsonRes = JSON.parse(cleanJsonStr);

          if (jsonRes.result === 'pass') {
            aiPassed = true;
            break; 
          } else {
            aiErrorMsg = jsonRes.reason || 'AI検証により不合格と判定されました。';
          }
        } catch (err) {
          console.warn(`Model ${modelName} with Key [${keyIdx + 1}] failed:`, err.message);
          aiErrorMsg = err.message;
        }
      }

      if (aiPassed) break; 
    }

    if (!aiPassed) {
      return res.status(400).json({ status: 'fail', message: `AI画像検証に失敗しました: ${aiErrorMsg}` });
    }

    const passwordHash = hashPassword(password);

    const gasResponse = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'register',
        mcid: mcid,
        passwordHash: passwordHash
      })
    });

    const gasResult = await gasResponse.json();

    if (gasResult.status === 'success') {
      return res.json({ status: 'success', message: 'アカウントが正常に作成されました！' });
    } else {
      return res.status(400).json({ status: 'error', message: gasResult.message || 'スプレッドシートへの保存に失敗しました。' });
    }

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ status: 'error', message: 'サーバー内部エラーが発生しました。' });
  }
});

app.listen(PORT, () => {
  console.log(`Secure Backend is running on port ${PORT}`);
});
