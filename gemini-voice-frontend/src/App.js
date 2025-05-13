import React, { useState, useRef, useCallback, useEffect } from 'react';
import './App.css';

// Constants
const INPUT_SAMPLE_RATE = 16000; // For microphone input to Gemini
const OUTPUT_SAMPLE_RATE = 24000; // For Gemini's audio output
const MIC_BUFFER_SIZE = 4096;  // Buffer size for ScriptProcessorNode

const App = () => {
  const [status, setStatus] = useState('Idle. Click Start Listening.');
  const [isRecording, setIsRecording] = useState(false);
  // const [isConnected, setIsConnected] = useState(false); // You can use this for UI if needed
  const [geminiResponseStatus, setGeminiResponseStatus] = useState('No Gemini response yet.');

  // Ref for isRecording state to be used in onaudioprocess
  const isRecordingRef = useRef(isRecording);

  const playbackAudioContextRef = useRef(null); // For playing Gemini's audio
  const localAudioContextRef = useRef(null);    // For processing microphone audio
  const mediaStreamRef = useRef(null);          // Holds the MediaStream from getUserMedia
  const scriptProcessorNodeRef = useRef(null);  // For microphone audio processing

  const socketRef = useRef(null);
  const audioQueueRef = useRef([]);             // Queue for Gemini's audio chunks
  const isPlayingRef = useRef(false);           // To manage playback state of Gemini's audio
  const currentAudioSourceRef = useRef(null);   // Ref for the currently playing AudioBufferSourceNode

  // Keep isRecordingRef.current in sync with isRecording state
  useEffect(() => {
    isRecordingRef.current = isRecording;
    console.log(`[EFFECT] isRecording state changed to: ${isRecording}, isRecordingRef.current updated to: ${isRecordingRef.current}`);
  }, [isRecording]);

  // --- AudioContext Management (Playback) ---
  const getPlaybackAudioContext = useCallback(async (triggeredByAction) => {
    console.log(`[CTX_PLAYBACK_MGR] getPlaybackAudioContext called by: ${triggeredByAction}`);
    if (!playbackAudioContextRef.current) {
      try {
        console.log('[CTX_PLAYBACK_MGR] Attempting to CREATE Playback AudioContext.');
        playbackAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: OUTPUT_SAMPLE_RATE,
        });
        playbackAudioContextRef.current.onstatechange = () => {
          const newState = playbackAudioContextRef.current?.state;
          console.log(`[CTX_PLAYBACK_MGR_EVENT] Playback state CHANGED to: ${newState}`);
          setStatus(prev => `${prev.split(' | ')[0]} | PlaybackCTX: ${newState}`);
        };
        const initialState = playbackAudioContextRef.current.state;
        console.log(`[CTX_PLAYBACK_MGR] Playback AudioContext CREATED. Initial state: ${initialState}, SampleRate: ${playbackAudioContextRef.current.sampleRate}`);
        setStatus(prev => `PlaybackCTX Ready (${initialState}) | ${prev.split(' | ').pop() || ''}`);
      } catch (e) {
        console.error('[CTX_PLAYBACK_MGR] !!! FAILED to CREATE Playback AudioContext !!!', e);
        setStatus(`FATAL PlaybackCTX ERROR: ${e.message}`);
        playbackAudioContextRef.current = null; return null;
      }
    }

    if (playbackAudioContextRef.current.state === 'suspended') {
      if (triggeredByAction && triggeredByAction.toLowerCase().includes("user_action")) {
        console.log(`[CTX_PLAYBACK_MGR] PlaybackCTX State 'suspended'. Attempting RESUME by: ${triggeredByAction}.`);
        try {
          await playbackAudioContextRef.current.resume();
          console.log(`[CTX_PLAYBACK_MGR] PlaybackCTX Resume attempt finished. State: ${playbackAudioContextRef.current.state}`);
        } catch (e) {
          console.error(`[CTX_PLAYBACK_MGR] !!! FAILED to RESUME PlaybackCTX !!!`, e);
        }
      }
    }
    const finalState = playbackAudioContextRef.current?.state;
     setStatus(prev => {
        const parts = prev.split(' | ');
        parts[0] = `PlaybackCTX: ${finalState || 'N/A'}`; // Ensure parts[0] is always updated or default
        return parts.join(' | ');
    });
    if (finalState !== 'running') console.warn(`[CTX_PLAYBACK_MGR_WARN] PlaybackCTX not 'running'. State: ${finalState}`);
    return playbackAudioContextRef.current;
  }, []);


  // --- Play Gemini's Audio Response ---
  const playNextGeminiChunk = useCallback(async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) return;
    isPlayingRef.current = true;
    const arrayBuffer = audioQueueRef.current.shift();
    // setGeminiResponseStatus(`Playing chunk: ${arrayBuffer.byteLength} bytes`); // Can be noisy

    const audioCtx = await getPlaybackAudioContext("playNextGeminiChunk_SystemAction");
    if (!audioCtx || audioCtx.state !== 'running') {
      console.error(`[GEMINI_PLAY] Cannot play: PlaybackCTX not 'running'. State: ${audioCtx?.state}`);
      setGeminiResponseStatus(`Playback FAIL: Audio system not ready (${audioCtx?.state})`);
      isPlayingRef.current = false; return;
    }
    try {
      if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength % 2 !== 0) {
        console.error("[GEMINI_PLAY] Invalid ArrayBuffer (0 bytes or odd length). Skipping.", arrayBuffer.byteLength);
        isPlayingRef.current = false; playNextGeminiChunk(); return;
      }
      const pcm16Data = new Int16Array(arrayBuffer);
      let minPcm = pcm16Data[0]||0, maxPcm = pcm16Data[0]||0, sumPcm = 0;
      for (let i = 0; i < pcm16Data.length; i++) { if (pcm16Data[i] < minPcm) minPcm = pcm16Data[i]; if (pcm16Data[i] > maxPcm) maxPcm = pcm16Data[i]; sumPcm += pcm16Data[i];}
      const avgPcm = pcm16Data.length > 0 ? sumPcm / pcm16Data.length : 0;
      console.log(`[GEMINI_DATA] PCM16 (${pcm16Data.length} samples): Min=${minPcm}, Max=${maxPcm}, Avg=${avgPcm.toFixed(2)}`);
      if (maxPcm === 0 && minPcm === 0 && pcm16Data.length > 0) console.warn("*** [GEMINI_DATA] PCM16 data ALL ZEROS! ***");

      const float32Data = new Float32Array(pcm16Data.length);
      for (let i = 0; i < pcm16Data.length; i++) float32Data[i] = pcm16Data[i] / 32768.0;
      
      let minF32 = float32Data[0]||0, maxF32 = float32Data[0]||0, sumF32 = 0, nonZeroCount = 0;
      for (let i = 0; i < float32Data.length; i++) { if (float32Data[i] < minF32) minF32 = float32Data[i]; if (float32Data[i] > maxF32) maxF32 = float32Data[i]; sumF32 += float32Data[i]; if (Math.abs(float32Data[i]) > 0.0001) nonZeroCount++;}
      const avgF32 = float32Data.length > 0 ? sumF32 / float32Data.length : 0;
      console.log(`[GEMINI_DATA] F32 (${float32Data.length} samples): Min=${minF32.toFixed(4)}, Max=${maxF32.toFixed(4)}, Avg=${avgF32.toFixed(4)}, NonZero=${nonZeroCount}`);
      if (nonZeroCount < float32Data.length * 0.01 && float32Data.length > 100) console.warn("*** [GEMINI_DATA] F32 data very quiet! ***");
      
      if (float32Data.length === 0) { console.warn("[GEMINI_PLAY] Float32 data empty. Skipping."); isPlayingRef.current = false; playNextGeminiChunk(); return;}
      
      const audioBuffer = audioCtx.createBuffer(1, float32Data.length, OUTPUT_SAMPLE_RATE);
      audioBuffer.copyToChannel(float32Data, 0);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      const gainNode = audioCtx.createGain();
      gainNode.gain.setValueAtTime(0.8, audioCtx.currentTime); // Decent volume
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      source.onended = () => {
        // console.log("[GEMINI_PLAY] Gemini audio chunk 'onended'."); // Can be noisy
        setGeminiResponseStatus('Chunk finished playing. Queue: ' + audioQueueRef.current.length);
        isPlayingRef.current = false;
        currentAudioSourceRef.current = null; // Clear the ref
        playNextGeminiChunk();
        source.disconnect(); gainNode.disconnect();
      };
      currentAudioSourceRef.current = source; // Store the source
      console.log("[GEMINI_PLAY] Starting playback of Gemini audio chunk...");
      source.start();
    } catch (error) {
        currentAudioSourceRef.current = null; // Clear ref on error too
        console.error("!!! [GEMINI_PLAY] Error in playNextGeminiChunk !!!", error);
        setGeminiResponseStatus(`Playback Error: ${error.message}`);
        isPlayingRef.current = false;
        playNextGeminiChunk();
    }
  }, [getPlaybackAudioContext]);


  // --- WebSocket Connection ---
  const connectWebSocket = useCallback(() => {
    return new Promise((resolve, reject) => {
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        console.log("WS: Already connected.");
        // setIsConnected(true); // State for UI if needed
        setStatus(prev => `${prev.split(' | ')[0]} | WS: Connected`);
        resolve(socketRef.current);
        return;
      }
      setStatus(prev => `${prev.split(' | ')[0]} | WS: Connecting...`);
      socketRef.current = new WebSocket('ws://localhost:8000/listen');
      socketRef.current.binaryType = 'arraybuffer';

      socketRef.current.onopen = () => {
        console.log("WS: Connected!");
        // setIsConnected(true);
        setStatus(prev => `${prev.split(' | ')[0]} | WS: Connected`);
        resolve(socketRef.current);
      };
      socketRef.current.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (event.data.byteLength > 0) {
            console.log(`WS: Received audio ArrayBuffer: ${event.data.byteLength} bytes`);
            audioQueueRef.current.push(event.data);
            playNextGeminiChunk();
          }
        } else if (typeof event.data === 'string') {
          console.log('WS: Received raw text message:', event.data);
          try {
            const parsedMessage = JSON.parse(event.data);
            if (parsedMessage.action === "interrupt_playback") {
              console.log("WS: Received interrupt_playback signal!");
              setGeminiResponseStatus("Interruption signal received. Clearing audio queue.");
              audioQueueRef.current = []; // Clear the queue
              if (currentAudioSourceRef.current) {
                console.log("WS: Stopping current audio source due to interruption.");
                currentAudioSourceRef.current.stop(0); // Stop current playback
                // onended will set isPlayingRef to false and currentAudioSourceRef to null
              }
              isPlayingRef.current = false; // Explicitly set here too, to allow next play if new audio comes fast
            } else {
              // Handle other JSON messages if any, or treat as plain text
              setGeminiResponseStatus("Text from Gemini (JSON): " + event.data);
            }
          } catch (e) {
            // Not a JSON message, treat as plain text
            setGeminiResponseStatus("Text from Gemini (Plain): " + event.data);
          }
        }
      };
      socketRef.current.onerror = (error) => {
        console.error('WS Error:', error);
        // setIsConnected(false);
        setStatus(prev => `${prev.split(' | ')[0]} | WS Error`);
        reject(error);
      };
      socketRef.current.onclose = (event) => {
        console.log('WS Closed:', event.reason);
        // setIsConnected(false);
        setIsRecording(false); // Also update main recording state
        setStatus(prev => `${prev.split(' | ')[0]} | WS Closed`);
      };
    });
  }, [playNextGeminiChunk]); // playNextGeminiChunk is a dependency


  // --- Microphone Input & Streaming ---
  const startListening = async () => {
    if (isRecordingRef.current) {
        console.log("startListening called, but isRecordingRef is already true. Exiting.");
        return;
    }
    console.log("--- startListening: User Clicked ---");
    setGeminiResponseStatus('Waiting for user audio...');
    setStatus("Init: PlaybackCTX...");
    const audioPlaybackCtx = await getPlaybackAudioContext("startListening_UserAction");
    if (!audioPlaybackCtx || audioPlaybackCtx.state !== 'running') {
      setStatus(`Mic FAIL: PlaybackCTX not ready (${audioPlaybackCtx?.state}). Click again.`);
      return;
    }

    setStatus("Init: WebSocket...");
    try {
      await connectWebSocket();
    } catch (error) {
      setStatus(`Mic FAIL: WebSocket connection error. Check console.`);
      return;
    }

    setStatus("Init: Mic AudioCTX...");
    if (!localAudioContextRef.current) {
      try {
        localAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: INPUT_SAMPLE_RATE,
        });
        console.log(`[CTX_MIC] Mic AudioContext CREATED. State: ${localAudioContextRef.current.state}, Rate: ${localAudioContextRef.current.sampleRate}`);
      } catch (e) {
        setStatus(`Mic FAIL: Cannot create Mic AudioCTX: ${e.message}`); return;
      }
    }
    if (localAudioContextRef.current.state === 'suspended') {
      try {
        console.log("[CTX_MIC] Resuming Mic AudioContext...");
        await localAudioContextRef.current.resume();
        console.log(`[CTX_MIC] Mic AudioContext Resumed. State: ${localAudioContextRef.current.state}`);
      } catch (e) {
        setStatus(`Mic FAIL: Error resuming Mic AudioCTX: ${e.message}`); return;
      }
    }
    setStatus(prev => `${prev.split(' | ')[0]} | MicCTX: ${localAudioContextRef.current.state}`);


    setStatus("Mic: Requesting permission...");
    try {
      mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: INPUT_SAMPLE_RATE, channelCount: 1,
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        },
      });
      console.log("Mic: Permission GRANTED.");
      setStatus("Mic: Permission granted. Setting up...");

      const sourceNode = localAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);
      const actualMicSampleRate = sourceNode.context.sampleRate; // Capture this for use in onaudioprocess
      console.log(`Mic: Actual capture rate: ${actualMicSampleRate}Hz. Target: ${INPUT_SAMPLE_RATE}Hz.`);
      if (actualMicSampleRate !== INPUT_SAMPLE_RATE) console.warn("Mic: Resampling needed for input.");
      
      scriptProcessorNodeRef.current = localAudioContextRef.current.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);
      console.log("Mic: ScriptProcessorNode created.");
      
      // Assigning to a variable that an effect can depend on if re-assigning `onaudioprocess`
      // For now, direct assignment is okay since `actualMicSampleRate` is in closure.
      scriptProcessorNodeRef.current.onaudioprocess = (event) => {
        // console.log("[ONA_AUDIO_PROCESS] Tick!"); // Enable for extreme debug
        if (!isRecordingRef.current) { 
          // console.log("[ONA_AUDIO_PROCESS] Not recording (isRecordingRef is false), returning.");
          return; 
        }
        if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
          console.log(`[ONA_AUDIO_PROCESS] WebSocket not open. Current state: ${socketRef.current?.readyState} (Expected: ${WebSocket.OPEN}). Returning.`);
          return;
        }
        
        const inputBuffer = event.inputBuffer;
        const pcmDataFloat32 = inputBuffer.getChannelData(0);
        let resampledData = pcmDataFloat32;
        if (actualMicSampleRate !== INPUT_SAMPLE_RATE) { // Use actualMicSampleRate from closure
            const ratio = actualMicSampleRate / INPUT_SAMPLE_RATE;
            resampledData = new Float32Array(Math.floor(pcmDataFloat32.length / ratio));
            for (let i = 0, j = 0; i < resampledData.length; i++, j += ratio) { resampledData[i] = pcmDataFloat32[Math.floor(j)]; }
        }
        const int16Pcm = new Int16Array(resampledData.length);
        for (let i = 0; i < resampledData.length; i++) { const s = Math.max(-1, Math.min(1, resampledData[i])); int16Pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; }
        
        // console.log(`[ONA_AUDIO_PROCESS] Attempting to send ${int16Pcm.byteLength} bytes.`); // Enable for extreme debug
        socketRef.current.send(int16Pcm.buffer);
      };

      sourceNode.connect(scriptProcessorNodeRef.current);
      // Connect to destination to ensure onaudioprocess fires. You will hear your mic.
      scriptProcessorNodeRef.current.connect(localAudioContextRef.current.destination); 
      console.log("Mic: Audio processing pipeline connected (mic will be audible).");

      setIsRecording(true); // Set state to true to update UI and isRecordingRef via useEffect
      setStatus('Status: Listening... Speak into your microphone.');
    } catch (error) {
      console.error("Mic: Error during setup:", error);
      setStatus(`Mic Error: ${error.name}: ${error.message}. Check permissions.`);
      if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(track => track.stop());
      setIsRecording(false); // Reset state
    }
  };

  const stopListening = () => {
    console.log("--- stopListening: User Clicked ---");
    if (!isRecording && !mediaStreamRef.current) { // Check state primarily
        setStatus('Status: Not currently listening.'); 
        return; 
    }
    setStatus('Status: Stopping listening...');
    setIsRecording(false); // This will update isRecordingRef.current via useEffect

    if (mediaStreamRef.current) { 
        console.log("Mic: Stopping media stream tracks."); 
        mediaStreamRef.current.getTracks().forEach(track => track.stop()); 
        mediaStreamRef.current = null; 
    }
    if (scriptProcessorNodeRef.current) { 
        console.log("Mic: Disconnecting ScriptProcessorNode."); 
        scriptProcessorNodeRef.current.disconnect(); 
        scriptProcessorNodeRef.current.onaudioprocess = null; // Important!
        scriptProcessorNodeRef.current = null; 
    }
    setStatus('Status: Stopped sending mic audio. Waiting for final Gemini response...');
  };

  // --- Effect for Cleanup ---
  useEffect(() => {
    return () => {
      console.log("[LIFECYCLE] App unmounting: Cleanup.");
      if (socketRef.current && (socketRef.current.readyState === WebSocket.OPEN || socketRef.current.readyState === WebSocket.CONNECTING) ) {
        socketRef.current.close(1000, "React component unmounting");
      }
      if (playbackAudioContextRef.current && playbackAudioContextRef.current.state !== 'closed') {
        playbackAudioContextRef.current.close().catch(e => console.warn("Error closing playback AC on unmount:", e));
      }
      if (localAudioContextRef.current && localAudioContextRef.current.state !== 'closed') {
        localAudioContextRef.current.close().catch(e => console.warn("Error closing local (mic) AC on unmount:", e));
      }
      playbackAudioContextRef.current = null;
      localAudioContextRef.current = null;
      mediaStreamRef.current = null;
      scriptProcessorNodeRef.current = null;
      socketRef.current = null;
    };
  }, []); // Empty dependency array ensures this runs only on mount and unmount

  return (
    <div className="App">
      <header className="App-header">
        <p><b>App Status:</b> {status}</p>
        <p><b>Gemini Audio:</b> {geminiResponseStatus}</p>
        {!isRecording ? (
          <button onClick={startListening} style={{ fontSize: '20px', padding: '15px', margin: '10px', backgroundColor: 'lightgreen' }}>
            Start Listening (Mic)
          </button>
        ) : (
          <button onClick={stopListening} style={{ fontSize: '20px', padding: '15px', margin: '10px', backgroundColor: 'salmon' }}>
            Stop Listening
          </button>
        )}
      </header>
    </div>
  );
};

export default App;