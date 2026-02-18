import { MIDIParser } from './midi-parser.js';

export class MIDIPlayer {
    constructor(visualizer) {
        this.midiData = null;
        this.isPlaying = false;
        this.isPaused = false;
        this.currentTime = 0;
        this.duration = 0;
        this.scheduledEvents = [];
        this.audioContext = null;
        this.volume = 30;
        this.tempo = 100;
        this.waveType = 'piano';
        this.visualizer = visualizer;
        this.updateInterval = null;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.isRecording = false;
        this.recordingDestination = null;

        // Web Audio Font
        if (typeof WebAudioFontPlayer !== 'undefined') {
            this.player = new WebAudioFontPlayer();
        } else {
            console.warn('WebAudioFontPlayer not available, will use fallback synthesizer when playing notes');
            this.player = null;
        }
        this.instruments = {}; // Кэш: {program: font}
        this.channelPrograms = new Array(16).fill(0); // Program по каналам (GM)
        this.loadingFonts = new Set(); // Предотвращает дубли загрузки
        this.loadingPromises = new Map(); // Stores loading promises for concurrent requests
    }

    async init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        // Preload default piano instrument
        if (!this.instruments[0]) {
            await this.preloadDefaultInstrument();
        }
    }

    loadMIDI(arrayBuffer) {
        try {
            const parser = new MIDIParser(arrayBuffer);
            this.midiData = parser.parse();
            this.calculateDuration();
            return this.midiData;
        } catch (error) {
            throw new Error('Ошибка парсинга MIDI: ' + error.message);
        }
    }

    calculateDuration() {
        if (!this.midiData) return;

        let maxTime = 0;
        const ticksPerBeat = this.midiData.ticksPerBeat;
        
        let currentTempo = 500000;
        const tempoChanges = [];

        this.midiData.tracks.forEach(track => {
            track.events.forEach(event => {
                if (event.type === 'tempo') {
                    tempoChanges.push({
                        tick: event.time,
                        microsecondsPerBeat: event.microsecondsPerBeat
                    });
                }
            });
        });

        tempoChanges.sort((a, b) => a.tick - b.tick);

        this.midiData.tracks.forEach(track => {
            track.events.forEach(event => {
                const time = this.ticksToSeconds(event.time, ticksPerBeat, tempoChanges);
                if (time > maxTime) {
                    maxTime = time;
                }
            });
        });

        this.duration = maxTime;
    }

    ticksToSeconds(ticks, ticksPerBeat, tempoChanges) {
        let seconds = 0;
        let currentTick = 0;
        let currentTempo = 500000;

        for (let i = 0; i < tempoChanges.length; i++) {
            const change = tempoChanges[i];
            if (change.tick >= ticks) break;

            const deltaTicks = change.tick - currentTick;
            seconds += (deltaTicks / ticksPerBeat) * (currentTempo / 1000000);
            
            currentTick = change.tick;
            currentTempo = change.microsecondsPerBeat;
        }

        const deltaTicks = ticks - currentTick;
        seconds += (deltaTicks / ticksPerBeat) * (currentTempo / 1000000);

        return seconds;
    }

    async play(startTime = 0) {
        if (!this.midiData) return;

        await this.init();
        
        // Preload instruments before playing
        console.log('Preloading instruments before playback...');
        await this.preloadInstrumentsFromMIDI();
        
        this.isPlaying = true;
        this.isPaused = false;
        this.currentTime = startTime;
        this.visualizer.start();

        this.scheduleNotes(startTime);
        this.startTimeUpdate();
    }

    scheduleNotes(startTime) {
        const ticksPerBeat = this.midiData.ticksPerBeat;
        const tempoChanges = [];

        this.midiData.tracks.forEach(track => {
            track.events.forEach(event => {
                if (event.type === 'tempo') {
                    tempoChanges.push({
                        tick: event.time,
                        microsecondsPerBeat: event.microsecondsPerBeat
                    });
                }
            });
        });

        tempoChanges.sort((a, b) => a.tick - b.tick);

        const noteMap = new Map();

        this.midiData.tracks.forEach(track => {
            track.events.forEach(event => {
                const eventTime = this.ticksToSeconds(event.time, ticksPerBeat, tempoChanges);
                const adjustedTime = eventTime / (this.tempo / 100);

                if (adjustedTime < startTime) return;

                if (event.type === 'programChange') {
                    this.channelPrograms[event.channel] = event.program;
                    // For channel 9 (drums), load special drums instrument
                    const programToLoad = event.channel === 9 ? 128 : event.program;
                    this.loadInstrument(programToLoad); // Ленивая загрузка
                } else if (event.type === 'noteOn') {
                    noteMap.set(event.note + '_' + event.channel, {
                        note: event.note,
                        velocity: event.velocity,
                        startTime: adjustedTime,
                        channel: event.channel
                    });
                } else if (event.type === 'noteOff') {
                    const noteOn = noteMap.get(event.note + '_' + event.channel);
                    if (noteOn) {
                        const duration = adjustedTime - noteOn.startTime;
                        const delay = (noteOn.startTime - startTime) * 1000;

                        const timeoutId = setTimeout(() => {
                            if (this.isPlaying) {
                                this.playNote(noteOn.note, noteOn.velocity, duration, noteOn.channel);
                            }
                        }, delay);

                        this.scheduledEvents.push(timeoutId);
                        noteMap.delete(event.note + '_' + event.channel);
                    }
                }
            });
        });
    }

    async playNote(note, velocity, duration, channel) {
        if (!this.audioContext) return;

        // Channel 9 is drums in MIDI standard
        const program = channel === 9 ? 128 : (this.channelPrograms[channel] || 0);
        
        // Ensure instrument is loaded (should be preloaded, but fallback just in case)
        if (!this.instruments[program]) {
            await this.loadInstrument(program);
        }

        const instrument = this.instruments[program];
        
        // If no instrument available, fall back to piano
        if (!instrument && !this.instruments[0]) {
            await this.loadInstrument(0); // Load piano as fallback
        }
        
        const finalInstrument = instrument || this.instruments[0];
        
        if (!finalInstrument || !this.player) {
            console.warn(`No instrument available for program ${program}, skipping note`);
            return;
        }

        const now = this.audioContext.currentTime;
        const volume = (velocity / 127) * (this.volume / 100);

        // Create a gain node for proper routing
        const noteGain = this.audioContext.createGain();
        noteGain.gain.value = 1;
        
        // Connect to both destination and recording if active
        noteGain.connect(this.audioContext.destination);
        if (this.mediaRecorder && this.isRecording && this.recordingDestination) {
            noteGain.connect(this.recordingDestination);
        }

        // Play the note through WebAudioFont
        this.player.queueWaveTable(
            this.audioContext,
            noteGain,
            finalInstrument,
            now,
            note,
            duration,
            volume
        );

        // Pass note to visualizer
        this.visualizer.addNote(note, velocity);

        setTimeout(() => {
            this.visualizer.removeNote(note);
        }, duration * 1000);
    }

    async loadInstrument(program) {
        // If already loaded, return immediately
        if (this.instruments[program]) return;
        
        // If currently loading, wait for the existing promise to resolve
        if (this.loadingFonts.has(program)) {
            const existingPromise = this.loadingPromises.get(program);
            if (existingPromise) {
                await existingPromise;
                return;
            }
        }
        
        this.loadingFonts.add(program);
        
        // Store the loading promise so other calls can await it
        const loadPromise = this._doLoadInstrument(program);
        this.loadingPromises.set(program, loadPromise);
        
        try {
            await loadPromise;
        } finally {
            this.loadingFonts.delete(program);
            this.loadingPromises.delete(program);
        }
    }
    
    async _doLoadInstrument(program) {
        // GM mapping: program -> font URL and variable name
        // WebAudioFont uses correct file naming convention with _file suffix
        const fontUrls = {
            0: { url: 'https://surikov.github.io/webaudiofontdata/sound/0000_JCLive_sf2_file.js', var: '_tone_0000_JCLive_sf2_file' }, // Acoustic Grand Piano
            1: { url: 'https://surikov.github.io/webaudiofontdata/sound/0001_JCLive_sf2_file.js', var: '_tone_0001_JCLive_sf2_file' }, // Bright Acoustic Piano
            24: { url: 'https://surikov.github.io/webaudiofontdata/sound/0240_Aspirin_sf2_file.js', var: '_tone_0240_Aspirin_sf2_file' }, // Acoustic Guitar (nylon)
            25: { url: 'https://surikov.github.io/webaudiofontdata/sound/0250_Aspirin_sf2_file.js', var: '_tone_0250_Aspirin_sf2_file' }, // Acoustic Guitar (steel)
            32: { url: 'https://surikov.github.io/webaudiofontdata/sound/0320_Aspirin_sf2_file.js', var: '_tone_0320_Aspirin_sf2_file' }, // Acoustic Bass
            33: { url: 'https://surikov.github.io/webaudiofontdata/sound/0330_Aspirin_sf2_file.js', var: '_tone_0330_Aspirin_sf2_file' }, // Electric Bass (finger)
            40: { url: 'https://surikov.github.io/webaudiofontdata/sound/0400_Aspirin_sf2_file.js', var: '_tone_0400_Aspirin_sf2_file' }, // Violin
            48: { url: 'https://surikov.github.io/webaudiofontdata/sound/0480_Aspirin_sf2_file.js', var: '_tone_0480_Aspirin_sf2_file' }, // String Ensemble 1
            56: { url: 'https://surikov.github.io/webaudiofontdata/sound/0560_Aspirin_sf2_file.js', var: '_tone_0560_Aspirin_sf2_file' }, // Trumpet
            73: { url: 'https://surikov.github.io/webaudiofontdata/sound/0730_Aspirin_sf2_file.js', var: '_tone_0730_Aspirin_sf2_file' }, // Flute
            // Program 128 is used internally to represent drums for MIDI channel 9 (percussion channel)
            // WebAudioFont provides complete drum kits as multi-zone instruments
            // Using the standard drum kit which includes all GM percussion sounds
            128: { url: 'https://surikov.github.io/webaudiofontdata/sound/12800_0_JCLive_sf2_file.js', var: '_drum_0_0_JCLive_sf2_file' }, // Standard Drum Kit (channel 9)
        };

        const fontInfo = fontUrls[program] || fontUrls[0]; // Default to piano
        const url = fontInfo.url;
        const varName = fontInfo.var;

        try {
            console.log(`Loading instrument ${program} from ${url}...`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const script = await response.text();
            
            // Use new Function() instead of eval() for better security
            // NOTE: This still executes arbitrary code from the CDN
            // Security considerations:
            // - Only load from trusted CDN (surikov.github.io)
            // - Consider implementing Content Security Policy headers
            // - Consider implementing Subresource Integrity (SRI) checks for production
            const loadFont = new Function(script);
            loadFont();
            
            if (window[varName]) {
                this.instruments[program] = window[varName];
                console.log(`✓ Loaded instrument ${program} (${varName})`);
            } else {
                throw new Error(`Variable ${varName} not found in loaded script`);
            }
        } catch (error) {
            console.error(`✗ Failed to load font for program ${program}:`, error);
            // Fallback to piano if available, otherwise null
            if (program !== 0 && this.instruments[0]) {
                console.log(`  → Using piano as fallback for program ${program}`);
                this.instruments[program] = this.instruments[0];
            } else {
                this.instruments[program] = null;
            }
        }
    }

    async preloadDefaultInstrument() {
        console.log('Preloading default piano instrument...');
        await this.loadInstrument(0); // Load piano
    }

    async preloadInstrumentsFromMIDI() {
        if (!this.midiData) return;
        
        const programsToLoad = new Set();
        
        // Collect all program changes and channel usage
        this.midiData.tracks.forEach(track => {
            track.events.forEach(event => {
                if (event.type === 'programChange') {
                    // For channel 9 (drums), load special drums instrument
                    const program = event.channel === 9 ? 128 : event.program;
                    programsToLoad.add(program);
                } else if (event.type === 'noteOn' && event.channel === 9) {
                    // If channel 9 has notes but no program change, ensure drums are loaded
                    programsToLoad.add(128);
                }
            });
        });
        
        // If no program changes found, default to piano
        if (programsToLoad.size === 0) {
            programsToLoad.add(0);
        }
        
        console.log(`Preloading ${programsToLoad.size} instruments:`, Array.from(programsToLoad));
        
        // Load all instruments in parallel
        await Promise.all(
            Array.from(programsToLoad).map(program => this.loadInstrument(program))
        );
        
        console.log('✓ All instruments preloaded successfully');
    }

    pause() {
        this.isPlaying = false;
        this.isPaused = true;
        this.clearScheduledEvents();
        this.stopTimeUpdate();
    }

    stop() {
        this.isPlaying = false;
        this.isPaused = false;
        this.currentTime = 0;
        this.clearScheduledEvents();
        this.stopTimeUpdate();
        this.visualizer.stop();
    }

    clearScheduledEvents() {
        this.scheduledEvents.forEach(id => clearTimeout(id));
        this.scheduledEvents = [];
    }

    startTimeUpdate() {
        const startTime = Date.now();
        const initialTime = this.currentTime;

        this.updateInterval = setInterval(() => {
            if (this.isPlaying) {
                const elapsed = (Date.now() - startTime) / 1000;
                this.currentTime = initialTime + elapsed * (this.tempo / 100);

                if (this.currentTime >= this.duration) {
                    this.stop();
                }
            }
        }, 100);
    }

    stopTimeUpdate() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    setVolume(volume) {
        this.volume = volume;
    }

    setTempo(tempo) {
        const wasPlaying = this.isPlaying;
        const currentTime = this.currentTime;

        if (wasPlaying) {
            this.stop();
        }

        this.tempo = tempo;

        if (wasPlaying) {
            this.play(currentTime);
        }
    }

    setWaveType(type) {
        this.waveType = type;
    }

    seek(time) {
        const wasPlaying = this.isPlaying;
        this.stop();
        this.currentTime = time;
        
        if (wasPlaying) {
            this.play(time);
        }
    }

    async startRecording() {
        await this.init();
        
        this.recordingDestination = this.audioContext.createMediaStreamDestination();
        this.mediaRecorder = new MediaRecorder(this.recordingDestination.stream);
        this.recordedChunks = [];

        this.mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                this.recordedChunks.push(event.data);
            }
        };

        this.mediaRecorder.start();
        this.isRecording = true;
    }

    stopRecording() {
        return new Promise((resolve) => {
            if (!this.mediaRecorder) {
                resolve(null);
                return;
            }

            this.mediaRecorder.onstop = () => {
                const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
                this.isRecording = false;
                this.mediaRecorder = null;
                this.recordingDestination = null;
                resolve(blob);
            };

            this.mediaRecorder.stop();
        });
    }

    exportToJSON() {
        if (!this.midiData) return null;

        const ticksPerBeat = this.midiData.ticksPerBeat;
        const tempoChanges = [];

        this.midiData.tracks.forEach(track => {
            track.events.forEach(event => {
                if (event.type === 'tempo') {
                    tempoChanges.push({
                        tick: event.time,
                        microsecondsPerBeat: event.microsecondsPerBeat
                    });
                }
            });
        });

        tempoChanges.sort((a, b) => a.tick - b.tick);

        const tracks = this.midiData.tracks.map(track => {
            const noteMap = new Map();
            const notes = [];

            track.events.forEach(event => {
                const eventTime = this.ticksToSeconds(event.time, ticksPerBeat, tempoChanges);

                if (event.type === 'noteOn') {
                    noteMap.set(event.note, {
                        note: event.note,
                        velocity: event.velocity,
                        time: eventTime
                    });
                } else if (event.type === 'noteOff') {
                    const noteOn = noteMap.get(event.note);
                    if (noteOn) {
                        notes.push({
                            note: noteOn.note,
                            time: noteOn.time,
                            duration: eventTime - noteOn.time,
                            velocity: noteOn.velocity
                        });
                        noteMap.delete(event.note);
                    }
                }
            });

            return { notes };
        });

        return { tracks };
    }

    async exportToWAV() {
        if (!this.midiData) return null;

        console.log('Starting WAV export...');
        
        // First, preload all instruments needed for export
        await this.preloadInstrumentsFromMIDI();

        const duration = this.duration;
        const sampleRate = 44100;
        const numberOfChannels = 2;

        const offlineContext = new OfflineAudioContext(
            numberOfChannels, 
            Math.ceil(sampleRate * duration), 
            sampleRate
        );
        
        const offlineGain = offlineContext.createGain();
        offlineGain.gain.value = this.volume / 100;
        offlineGain.connect(offlineContext.destination);

        const ticksPerBeat = this.midiData.ticksPerBeat;
        const tempoChanges = [];

        // Collect tempo changes using for...of
        for (const track of this.midiData.tracks) {
            for (const event of track.events) {
                if (event.type === 'tempo') {
                    tempoChanges.push({
                        tick: event.time,
                        microsecondsPerBeat: event.microsecondsPerBeat
                    });
                }
            }
        }

        tempoChanges.sort((a, b) => a.tick - b.tick);

        // Process all tracks and schedule notes
        for (const track of this.midiData.tracks) {
            const noteMap = new Map();
            
            for (const event of track.events) {
                const eventTime = this.ticksToSeconds(event.time, ticksPerBeat, tempoChanges) / (this.tempo / 100);

                if (event.type === 'noteOn') {
                    noteMap.set(event.note + '_' + event.channel, {
                        note: event.note,
                        velocity: event.velocity,
                        startTime: eventTime,
                        channel: event.channel
                    });
                } else if (event.type === 'noteOff') {
                    const noteOn = noteMap.get(event.note + '_' + event.channel);
                    if (noteOn) {
                        const noteDuration = eventTime - noteOn.startTime;
                        
                        // Channel 9 is drums in MIDI standard
                        const program = noteOn.channel === 9 ? 128 : (this.channelPrograms[noteOn.channel] || 0);
                        const instrument = this.instruments[program] || this.instruments[0]; // Fallback to piano
                        
                        if (instrument && this.player) {
                            // Use Web Audio Font for offline rendering
                            this.player.queueWaveTable(
                                offlineContext,
                                offlineGain,
                                instrument,
                                noteOn.startTime,
                                noteOn.note,
                                noteDuration,
                                (noteOn.velocity / 127)
                            );
                        } else {
                            console.warn(`No instrument available for program ${program}, skipping note`);
                        }
                        
                        noteMap.delete(event.note + '_' + event.channel);
                    }
                }
            }
        }

        try {
            console.log('Rendering audio buffer...');
            const renderedBuffer = await offlineContext.startRendering();
            console.log('Converting to WAV format...');
            const wavBlob = this.audioBufferToWav(renderedBuffer);
            console.log('✓ WAV export completed successfully');
            return wavBlob;
        } catch (error) {
            console.error('✗ Error during WAV export:', error);
            throw error;
        }
    }

    audioBufferToWav(buffer) {
        const numberOfChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const format = 1;
        const bitDepth = 16;

        const bytesPerSample = bitDepth / 8;
        const blockAlign = numberOfChannels * bytesPerSample;

        const data = [];
        for (let i = 0; i < buffer.length; i++) {
            for (let channel = 0; channel < numberOfChannels; channel++) {
                const sample = buffer.getChannelData(channel)[i];
                const clampedSample = Math.max(-1, Math.min(1, sample));
                const intSample = clampedSample < 0 
                    ? clampedSample * 0x8000 
                    : clampedSample * 0x7FFF;
                data.push(Math.round(intSample));
            }
        }

        const dataLength = data.length * bytesPerSample;
        const arrayBuffer = new ArrayBuffer(44 + dataLength);
        const view = new DataView(arrayBuffer);

        this.writeStringToView(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataLength, true);
        this.writeStringToView(view, 8, 'WAVE');
        this.writeStringToView(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, format, true);
        view.setUint16(22, numberOfChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        this.writeStringToView(view, 36, 'data');
        view.setUint32(40, dataLength, true);

        let offset = 44;
        for (let i = 0; i < data.length; i++) {
            view.setInt16(offset, data[i], true);
            offset += 2;
        }

        return new Blob([arrayBuffer], { type: 'audio/wav' });
    }

    writeStringToView(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }
}