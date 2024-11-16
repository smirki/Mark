// Import required modules
const Mic = require('mic');
const fs = require('fs');
const say = require('say');
const Groq = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Porcupine = require('@picovoice/porcupine-node').Porcupine;
const VAD = require('node-vad');
const wav = require('wav');
const player = require('play-sound')();

// Initialize Groq SDK
const groqApiKey = process.env.GROQ_API_KEY;
const groq = new Groq({ apiKey: groqApiKey });

// Initialize Gemini LLM
const geminiApiKey = process.env.GEMINI_API_KEY;
const genAI = new GoogleGenerativeAI(geminiApiKey);

const model = genAI.getGenerativeModel({
  model: "gemini-1.5-pro",
  systemInstruction: "You are Mark, a Jarvis alternative. You respond to user's requests in a funny, quirky, and concise way.",
  tools: [
    {
      functionDeclarations: [
        {
          name: "setTimer",
          description: "Set a timer for cooking or other purposes.",
          parameters: {
            type: "object",
            properties: {
              minutes: {
                type: "number",
                description: "Duration of the timer in minutes."
              }
            },
            required: ["minutes"]
          }
        }
      ]
    }
  ],
  toolConfig: { functionCallingConfig: { mode: "ANY" } },
});

const generationConfig = {
  temperature: 1,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 8192,
  responseMimeType: "text/plain",
};

// Initialize Porcupine Wake Word Detection without external calls
const porcupine = Porcupine.create(
  [fs.readFileSync('HeyMark.ppn')],
  [1.0] // Sensitivity
);

// VAD Setup
const vad = new VAD(VAD.Mode.NORMAL);

// Mic Setup
const micInstance = Mic({
  rate: '16000',
  channels: '1',
  debug: false,
  exitOnSilence: 0
});

const micInputStream = micInstance.getAudioStream();

const frameLength = porcupine.frameLength; // Should be 512
const sampleRate = porcupine.sampleRate; // Should be 16000

let isRecording = false;
let speechBuffer = [];
let audioBuffer = Buffer.alloc(0);

// Start the microphone
micInstance.start();

// Handle mic data
micInputStream.on('data', (data) => {
  if (!isRecording) {
    // Wake word detection
    audioBuffer = Buffer.concat([audioBuffer, data]);

    while (audioBuffer.length >= frameLength * 2) {
      let frame = audioBuffer.slice(0, frameLength * 2);
      audioBuffer = audioBuffer.slice(frameLength * 2);

      let pcm = new Int16Array(frameLength);
      for (let i = 0; i < frameLength; i++) {
        pcm[i] = frame.readInt16LE(i * 2);
      }

      let keywordIndex = porcupine.process(pcm);

      if (keywordIndex >= 0) {
        console.log('Wake word detected!');
        startUserSpeechRecording();
        break;
      }
    }
  } else {
    // User speech recording
    speechBuffer.push(data);

    vad.processAudio(data, sampleRate).then((res) => {
      if (res === VAD.Event.SILENCE) {
        console.log('User stopped speaking.');
        stopUserSpeechRecording();
      }
    });
  }
});

// Function to start recording user speech
function startUserSpeechRecording() {
  isRecording = true;
  speechBuffer = [];
  console.log('Recording user speech...');
}

// Function to stop recording user speech
function stopUserSpeechRecording() {
  isRecording = false;
  console.log('Stopping recording.');

  let audioData = Buffer.concat(speechBuffer);

  // Save audio to WAV file
  saveAudioToFile(audioData, 'user_speech.wav', () => {
    processUserSpeech('user_speech.wav');
  });
}

// Function to save audio data to a WAV file
function saveAudioToFile(audioData, filename, callback) {
  let fileWriter = new wav.FileWriter(filename, {
    sampleRate: sampleRate,
    channels: 1
  });

  fileWriter.write(audioData);
  fileWriter.end();

  fileWriter.on('finish', () => {
    console.log('Audio saved to', filename);
    callback();
  });
}

// Function to process user speech with Groq API
function processUserSpeech(filename) {
  groq.audio.transcriptions.create({
    file: fs.createReadStream(filename),
    model: "whisper-large-v3",
    response_format: "verbose_json",
  }).then((transcription) => {
    console.log('Transcription:', transcription.text);
    processTranscription(transcription.text);
  }).catch((error) => {
    console.error('Error in transcription:', error);
  });
}

// Function to process transcription with Gemini LLM
function processTranscription(transcribedText) {
  const chatSession = model.startChat({
    generationConfig,
    history: [
      {
        role: "user",
        parts: [
          { text: transcribedText },
        ],
      },
    ],
  });

  chatSession.sendMessage(transcribedText).then((result) => {
    handleGeminiResponse(result);
  }).catch((error) => {
    console.error('Error in Gemini API:', error);
  });
}

// Function to handle Gemini LLM response
function handleGeminiResponse(result) {
  const candidate = result.response.candidates[0];
  const parts = candidate.content.parts;

  let responseText = '';
  let functionCalls = [];

  for (let part of parts) {
    if (part.functionCall) {
      const funcName = part.functionCall.name;
      const args = part.functionCall.args;
      functionCalls.push({ name: funcName, args: args });
    } else {
      responseText += part.text;
    }
  }

  if (responseText) {
    console.log('Mark:', responseText);
    say.speak(responseText);
  }

  // Execute any function calls
  functionCalls.forEach((func) => {
    if (func.name === 'setTimer') {
      setTimer(func.args);
    }
  });
}

// Function to set a timer
function setTimer(args) {
  const minutes = args.minutes;
  const milliseconds = minutes * 60 * 1000;

  console.log(`Setting a timer for ${minutes} minutes.`);
  say.speak(`Setting a timer for ${minutes} minutes.`);

  setTimeout(() => {
    console.log(`Timer for ${minutes} minutes is up!`);
    say.speak(`Timer for ${minutes} minutes is up!`);
    playSound();
  }, milliseconds);
}

// Function to play a sound when timer is up
function playSound() {
  player.play('alarm.mp3', function (err) {
    if (err) {
      console.error('Error playing sound:', err);
    }
  });
}
