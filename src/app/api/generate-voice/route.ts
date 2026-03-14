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

    // For subtitles: use the real name (what viewers see)
    const subtitleText = text.trim().replace(/\{first_name\}/gi, first_name || 'there');
    // For TTS: use pronunciation hint as-is if provided
    // speech-1.5 model handles hyphens naturally (e.g. "Deh-ni-sa" reads as flowing syllables)
    // Don't split hyphens into spaces — that makes TTS read them as separate words
    const rawPronunciation = (name_pronunciation && name_pronunciation.trim()) ? name_pronunciation.trim() : '';
    const ttsName = rawPronunciation || (first_name || 'there');
    const processedText = text.trim().replace(/\{first_name\}/gi, ttsName);

    const ttsResponse = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FISH_API_KEY}`,
        'Content-Type': 'application/json',
        'model': 'speech-1.5',
      },
      body: JSON.stringify({
        text: processedText,
        reference_id: ADAM_VOICE_ID,
        format: 'mp3',
        mp3_bitrate: 320,
      }),
    });

    if (!ttsResponse.ok) {
      const err = await ttsResponse.text();
      console.error('Fish Audio TTS failed:', ttsResponse.status, err);
      return NextResponse.json({ error: 'Voice generation failed: ' + err }, { status: 500 });
    }

    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());

    // Generate subtitle chunks using the REAL name (not pronunciation)
    // Use ttsWords for timing estimation (since TTS paces based on those words)
    // but subWords for display text
    const subWords = subtitleText.split(' ');
    const ttsWords = processedText.split(' ');
    const chunkSize = 8;
    const totalTtsWords = ttsWords.length;
    const totalSubWords = subWords.length;
    const msPerWord = 400;
    const totalDurationMs = totalTtsWords * msPerWord;
    const subtitles: Array<{ text: string; start: number; end: number }> = [];

    // Map subtitle word indices to proportional TTS timing
    // This handles cases where subWords and ttsWords have different lengths
    // (e.g. name "Denisa" in subtitles vs "Deh ni sa" in TTS)
    for (let i = 0; i < totalSubWords; i += chunkSize) {
      const chunk = subWords.slice(i, i + chunkSize).join(' ');
      const chunkEnd = Math.min(i + chunkSize, totalSubWords);
      // Map subtitle word position to proportional TTS position
      const startFrac = i / totalSubWords;
      const endFrac = chunkEnd / totalSubWords;
      const startMs = startFrac * totalDurationMs;
      const endMs = endFrac * totalDurationMs;
      subtitles.push({ text: chunk, start: startMs / 1000, end: endMs / 1000 });
    }

    return NextResponse.json({
      audio: audioBuffer.toString('base64'),
      subtitles,
      duration: totalDurationMs / 1000,
      text: subtitleText,
    });
  } catch (err: unknown) {
    console.error('Generate voice error:', err);
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 });
  }
}
