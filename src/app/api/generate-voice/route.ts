import { NextRequest, NextResponse } from 'next/server';

const FISH_API_KEY = process.env.FISH_AUDIO_API_KEY || '';
const ADAM_VOICE_ID = process.env.FISH_AUDIO_VOICE_ID || '';

// WHY 60: Fish Audio can take 15-30s for long texts; Vercel default is 10s
export const maxDuration = 60;

// WHY 5000: ~1250 words max. Beyond this Fish Audio times out or produces
// degraded audio. Also prevents abuse/cost spikes.
const MAX_TEXT_LENGTH = 5000;

export async function POST(req: NextRequest) {
  try {
    const { text, first_name, name_pronunciation } = await req.json();

    // --- Input validation ---
    if (!text || typeof text !== 'string' || !text.trim()) {
      return NextResponse.json({ error: 'Text is required' }, { status: 400 });
    }

    // WHY: Prevent abuse, Fish Audio timeouts, and excessive costs
    if (text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        { error: `Text too long (${text.length} chars). Maximum is ${MAX_TEXT_LENGTH}.` },
        { status: 400 }
      );
    }

    if (!FISH_API_KEY || !ADAM_VOICE_ID) {
      // WHY 503: Service misconfigured, not a client error
      return NextResponse.json(
        { error: 'Voice generation is not configured.' },
        { status: 503 }
      );
    }

    // --- Dual text processing ---
    // subtitleText: what viewers SEE (real name)
    // processedText: what TTS SPEAKS (pronunciation hint or real name)
    const subtitleText = text.trim().replace(/\{first_name\}/gi, first_name || 'there');

    // WHY: speech-1.5 model reads hyphens as flowing syllables natively.
    // Don't split hyphens into spaces — that makes TTS read them as separate words.
    const rawPronunciation = (name_pronunciation && name_pronunciation.trim()) ? name_pronunciation.trim() : '';
    const ttsName = rawPronunciation || (first_name || 'there');
    const processedText = text.trim().replace(/\{first_name\}/gi, ttsName);

    // WHY emotion anchor: Without this, the model infers tone from text sentiment alone,
    // causing "Hey John!" to sound happy but "I know budgets are tight" to sound depressed.
    // (confident) anchors the clone to an upbeat-but-professional tone for every generation.
    // Only applied to TTS input — NOT added to subtitleText so it never appears on screen.
    const ttsText = `(confident) ${processedText}`;

    // --- Fish Audio TTS API call ---
    const ttsResponse = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FISH_API_KEY}`,
        'Content-Type': 'application/json',
        // WHY header not body: Fish Audio API design — model is a request header
        'model': 'speech-1.5',
      },
      body: JSON.stringify({
        text: ttsText,
        reference_id: ADAM_VOICE_ID,
        format: 'mp3',
        // WHY 320: Maximum MP3 quality — preserves dynamics and clarity
        mp3_bitrate: 320,
        // WHY 0.5: Default is 0.7. Lower temp = more predictable, consistent tone
        // across different text sentiments. Still high enough to avoid robotic delivery.
        temperature: 0.5,
        // WHY 0.6: Works with temperature to constrain emotional variance.
        // Together they prevent the clone from randomly sounding depressed vs excited.
        top_p: 0.6,
      }),
    });

    // --- Status-specific error handling ---
    // WHY: Different errors need different client responses; never leak raw API internals
    if (!ttsResponse.ok) {
      const status = ttsResponse.status;
      console.error('Fish Audio TTS failed:', status);

      if (status === 401 || status === 403) {
        return NextResponse.json({ error: 'Voice service authentication failed' }, { status: 500 });
      }
      if (status === 429) {
        return NextResponse.json({ error: 'Voice service is rate limited. Please wait a moment and try again.' }, { status: 429 });
      }
      if (status === 400) {
        return NextResponse.json({ error: 'Voice generation request was invalid. Try shorter text.' }, { status: 400 });
      }
      // WHY: Don't leak raw Fish Audio error body — could contain internal URLs, keys, etc.
      return NextResponse.json({ error: 'Voice generation service error. Please try again.' }, { status: 502 });
    }

    // WHY arrayBuffer: Fish Audio returns raw binary MP3, not JSON
    const audioBuffer = Buffer.from(await ttsResponse.arrayBuffer());

    // --- Subtitle generation ---
    // WHY subWords for display, ttsWords for timing: pronunciation hint can change word count
    // (e.g. "Denisa" = 1 word in subtitles, but "Deh-ni-sa" = 1 hyphenated TTS word)
    const subWords = subtitleText.split(' ');
    const ttsWords = processedText.split(' ');
    const chunkSize = 8;
    const totalTtsWords = ttsWords.length;
    const totalSubWords = subWords.length;
    // WHY 400: Average speech rate ~150wpm = ~400ms/word. Rescaled on client anyway.
    const msPerWord = 400;
    const totalDurationMs = totalTtsWords * msPerWord;
    const subtitles: Array<{ text: string; start: number; end: number }> = [];

    // WHY proportional mapping: If subWords and ttsWords have different counts,
    // we map subtitle display positions to TTS timing proportionally.
    // Client rescales to actual audio duration anyway, so estimates just need to be proportional.
    for (let i = 0; i < totalSubWords; i += chunkSize) {
      const chunk = subWords.slice(i, i + chunkSize).join(' ');
      const chunkEnd = Math.min(i + chunkSize, totalSubWords);
      const startFrac = i / totalSubWords;
      const endFrac = chunkEnd / totalSubWords;
      const startMs = startFrac * totalDurationMs;
      const endMs = endFrac * totalDurationMs;
      // WHY /1000: Client expects seconds, not milliseconds
      subtitles.push({ text: chunk, start: startMs / 1000, end: endMs / 1000 });
    }

    return NextResponse.json({
      // WHY base64: Simplest binary transport in JSON; client decodes to Uint8Array
      audio: audioBuffer.toString('base64'),
      subtitles,
      duration: totalDurationMs / 1000,
      // WHY subtitleText: Client shows this to user; uses real name, not pronunciation
      text: subtitleText,
    });
  } catch (err: unknown) {
    console.error('Generate voice error:', err);
    // WHY: Never return raw stack traces or error details to client
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 });
  }
}
