import { MIDIParser } from './midi-parser.js';
import { createAdvancedOscillator } from './audio-synth.js';

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
    }

    async init() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
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
        await this.loadInstrument(program); // Убедитесь, что font загружен

        const instrument = this.instruments[program];
        if (!instrument || !this.player) {
            // Fallback to old synthesizer
            return this.fallbackPlayNote(note, velocity, duration);
        }

        const now = this.audioContext.currentTime;
        const volume = (velocity / 127) * (this.volume / 100);

        this.player.queueWaveTable(
            this.audioContext,
            this.audioContext.destination,
            instrument,
            now,
            note,
            duration,
            volume
        );

        // Передаём ноту в визуализатор
        this.visualizer.addNote(note, velocity);

        setTimeout(() => {
            this.visualizer.removeNote(note);
        }, duration * 1000);
    }

    fallbackPlayNote(note, velocity, duration) {
        // Старый код как fallback
        const time = this.audioContext.currentTime;
        const frequency = 440 * Math.pow(2, (note - 69) / 12);
        
        const soundResult = createAdvancedOscillator(
            this.audioContext, 
            frequency, 
            'piano', // Fallback to piano
            0
        );
        
        const oscillator = soundResult.oscillator;
        const customGain = soundResult.gainNode;
        const extras = soundResult.extras || [];
        
        const masterGain = this.audioContext.createGain();
        const volumeMultiplier = (velocity / 127) * (this.volume / 100);
        
        masterGain.gain.setValueAtTime(volumeMultiplier, time);
        masterGain.gain.exponentialRampToValueAtTime(0.01, time + duration);
        
        if (customGain) {
            customGain.connect(masterGain);
        } else {
            oscillator.connect(masterGain);
        }
        masterGain.connect(this.audioContext.destination);
        
        if (this.mediaRecorder && this.isRecording && this.recordingDestination) {
            masterGain.connect(this.recordingDestination);
        }
        
        if (oscillator && oscillator.start) {
            oscillator.start(time);
            const stopTime = soundResult.duration 
                ? Math.max(time + duration, time + soundResult.duration)
                : time + duration + 0.1;
            oscillator.stop(stopTime);
        }
        
        extras.forEach(osc => {
            if (osc && osc.start) {
                osc.start(time);
                osc.stop(time + duration + 0.1);
            }
        });

        this.visualizer.addNote(note, velocity);
        setTimeout(() => {
            this.visualizer.removeNote(note);
        }, duration * 1000);
    }

    async loadInstrument(program) {
        if (this.instruments[program] || this.loadingFonts.has(program)) return;
        this.loadingFonts.add(program);

        // GM mapping: program -> font URL and variable number
        // Note: File numbers don't always match program numbers in WebAudioFont
        // For example, Piano (program 0) uses file 0010_JCLive_sf2.js
        const fontUrls = {
            0: { url: 'https://surikov.github.io/webaudiofontdata/sound/0010_JCLive_sf2.js', varNum: 10 }, // Piano
            24: { url: 'https://surikov.github.io/webaudiofontdata/sound/0025_JCLive_sf2.js', varNum: 25 }, // Guitar
            32: { url: 'https://surikov.github.io/webaudiofontdata/sound/0033_JCLive_sf2.js', varNum: 33 }, // Bass
            48: { url: 'https://surikov.github.io/webaudiofontdata/sound/0048_JCLive_sf2.js', varNum: 48 }, // Strings
            // Program 128 is used internally to represent drums for MIDI channel 9 (percussion channel)
            // This is not a standard MIDI program number but a convenient way to map channel 9
            128: { url: 'https://surikov.github.io/webaudiofontdata/sound/0000_JCLive_sf2.js', varNum: 0 }, // Drums (channel 9)
            // Добавьте больше по GM-спецификации
        };

        const fontInfo = fontUrls[program] || fontUrls[0]; // Default to piano
        const url = fontInfo.url;
        const varNum = fontInfo.varNum;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const script = await response.text();
            // NOTE: Using eval() here as required by WebAudioFont library design
            // Security: Only load fonts from trusted CDN (surikov.github.io)
            // Consider implementing Content Security Policy and Subresource Integrity checks
            eval(script); // Загружает font в window
            
            // Предполагаем naming convention: _tone_XXXX_JCLive_sf2
            // Use the varNum from fontInfo which corresponds to the actual file number
            const varName = `_tone_${varNum.toString().padStart(4, '0')}_JCLive_sf2`;
            
            if (window[varName]) {
                this.instruments[program] = window[varName];
                console.log(`Loaded instrument ${program} (${varName})`);
            } else {
                throw new Error(`Variable ${varName} not found in loaded script`);
            }
        } catch (error) {
            console.error('Failed to load font for program', program, error);
            // Fallback to piano if available, otherwise null
            if (program !== 0 && this.instruments[0]) {
                this.instruments[program] = this.instruments[0];
            } else {
                this.instruments[program] = null;
            }
        }
        this.loadingFonts.delete(program);
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

        const scheduledOscillators = [];

        this.midiData.tracks.forEach(track => {
            const noteMap = new Map();
            
            track.events.forEach(event => {
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
                        await this.loadInstrument(program);
                        const instrument = this.instruments[program];
                        
                        if (instrument) {
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
                            // Fallback to old synth
                            const frequency = 440 * Math.pow(2, (noteOn.note - 69) / 12);
                            const soundResult = createAdvancedOscillator(
                                offlineContext, 
                                frequency, 
                                'piano',
                                noteOn.startTime
                            );
                            
                            const oscillator = soundResult.oscillator;
                            const customGain = soundResult.gainNode;
                            const extras = soundResult.extras || [];
                            
                            const noteGain = offlineContext.createGain();
                            const volumeMultiplier = (noteOn.velocity / 127);
                            
                            noteGain.gain.setValueAtTime(volumeMultiplier, noteOn.startTime);
                            noteGain.gain.exponentialRampToValueAtTime(0.01, noteOn.startTime + noteDuration);
                            
                            if (customGain) {
                                customGain.connect(noteGain);
                            } else {
                                oscillator.connect(noteGain);
                            }
                            noteGain.connect(offlineGain);
                            
                            if (oscillator && oscillator.start) {
                                oscillator.start(noteOn.startTime);
                                const stopTime = soundResult.duration 
                                    ? Math.max(noteOn.startTime + noteDuration, noteOn.startTime + soundResult.duration)
                                    : noteOn.startTime + noteDuration + 0.1;
                                oscillator.stop(stopTime);
                            }
                            
                            extras.forEach(osc => {
                                if (osc && osc.start) {
                                    osc.start(noteOn.startTime);
                                    osc.stop(noteOn.startTime + noteDuration + 0.1);
                                }
                            });
                            
                            scheduledOscillators.push({ oscillator, noteGain, extras });
                        }
                        
                        noteMap.delete(event.note + '_' + event.channel);
                    }
                }
            });
        });

        try {
            const renderedBuffer = await offlineContext.startRendering();
            const wavBlob = this.audioBufferToWav(renderedBuffer);
            return wavBlob;
        } catch (error) {
            console.error('Ошибка рендеринга:', error);
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