import { NextRequest, NextResponse } from 'next/server';

const FISH_API_KEY = process.env.FISH_AUDIO_API_KEY || '';
const ADAM_VOICE_ID = process.env.FISH_AUDIO_VOICE_ID || '';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { text, first_name, name_pronunciation } = await req.json();

    if (!text || typeof text !== 'string' || !text.trim()) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    if (!FISH_API_KEY || !ADAM_VOICE_ID) {
      return NextResponse.json(
        { error: 'Voice generation is not configured. Set FISH_AUDIO_API_KEY and FISH_AUDIO_VOICE_ID.' },
        { status: 503 }
      );
    }

    // For subtitles: use the real name
    const subtitleText = text.trim().replace(/\{first_name\}/gi, first_name || 'there');
    // For TTS: use the pronunciation hint if provided, otherwise use the real name
    const ttsName = (name_pronunciation && name_pronunciation.trim()) ? name_pronunciation.trim() : (first_name || 'there');
    const processedText = text.trim().replace(/\{first_name\}/gi, ttsName);

    const ttsResponse = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FISH_API_KEY}`,
        'Content-Type': 'application/json',
        'model': 's1',
      },
      body: JSON.stringify({
        text: processedText,
        reference_id: ADAM_VOICE_ID,
        format: 'mp3',
        mp3_bitrate: 192,
      }),
    });

    if (!ttsResponse.ok) {
      const err = await ttsResponse.text();
      console.error('Fish Audio TTS failed:', ttsResponse.status, err);
      return NextResponse.json({ error: 'Voice generation failed: ' + err }, { status: 500 });
    }

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());

    // Generate subtitle chunks using the REAL name (not pronunciation)
    const subWords = subtitleText.split(' ');
    const ttsWords = processedText.split(' ');
    const chunkSize = 8;
    const msPerWord = 400;
    const subtitles: Array<{ text: string; start: number; end: number }> = [];

    for (let i = 0; i < subWords.length; i += chunkSize) {
      const chunk = subWords.slice(i, i + chunkSize).join(' ');
      const startMs = i * msPerWord;
      const endMs = Math.min((i + chunkSize) * msPerWord, ttsWords.length * msPerWord);
      subtitles.push({ text: chunk, start: startMs / 1000, end: endMs / 1000 });
    }

    return NextResponse.json({
      audio: audioBuffer.toString('base64'),
      subtitles,
      duration: (ttsWords.length * msPerWord) / 1000,
      text: subtitleText,
    });
  } catch (err: unknown) {
    console.error('Generate voice error:', err);
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 });
  }
}
