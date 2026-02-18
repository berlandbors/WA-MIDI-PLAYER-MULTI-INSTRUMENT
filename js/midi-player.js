import { MIDIParser } from './midi-parser.js';
import { createAdvancedOscillator } from './audio-synth.js';

// ===== MIDI PLAYER =====
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

                if (event.type === 'noteOn') {
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
                                this.playNote(noteOn.note, noteOn.velocity, duration);
                            }
                        }, delay);

                        this.scheduledEvents.push(timeoutId);
                        noteMap.delete(event.note + '_' + event.channel);
                    }
                }
            });
        });
    }

    playNote(note, velocity, duration) {
        if (!this.audioContext) return;

        try {
            const time = this.audioContext.currentTime;
            const frequency = 440 * Math.pow(2, (note - 69) / 12);
            
            const soundResult = createAdvancedOscillator(
                this.audioContext, 
                frequency, 
                this.waveType, 
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
            
            // Запускаем BufferSourceNode
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
            
            // Передаём ноту в визуализатор
            this.visualizer.addNote(note, velocity);
            
            setTimeout(() => {
                this.visualizer.removeNote(note);
            }, duration * 1000);
            
        } catch (error) {
            console.error('Ошибка воспроизведения ноты:', error);
        }
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

    // ===== ЭКСПОРТ В WAV =====
    async exportToWAV() {
        if (!this.midiData) return null;

        const duration = this.duration;
        const sampleRate = 44100;
        const numberOfChannels = 2;

        // Создаём offline context для рендеринга
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

        // Планируем все ноты для offline рендеринга
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
                        
                        const frequency = 440 * Math.pow(2, (noteOn.note - 69) / 12);
                        
                        const soundResult = createAdvancedOscillator(
                            offlineContext, 
                            frequency, 
                            this.waveType, 
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
                        
                        // Запускаем BufferSourceNode
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
                        
                        noteMap.delete(event.note + '_' + event.channel);
                    }
                }
            });
        });

        // Рендерим audio
        try {
            const renderedBuffer = await offlineContext.startRendering();
            
            // Конвертируем в WAV
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
        const format = 1; // PCM
        const bitDepth = 16;

        const bytesPerSample = bitDepth / 8;
        const blockAlign = numberOfChannels * bytesPerSample;

        // Интерлейсим каналы
        const data = [];
        for (let i = 0; i < buffer.length; i++) {
            for (let channel = 0; channel < numberOfChannels; channel++) {
                const sample = buffer.getChannelData(channel)[i];
                // Клампим значения
                const clampedSample = Math.max(-1, Math.min(1, sample));
                // Конвертируем в 16-bit integer
                const intSample = clampedSample < 0 
                    ? clampedSample * 0x8000 
                    : clampedSample * 0x7FFF;
                data.push(Math.round(intSample));
            }
        }

        const dataLength = data.length * bytesPerSample;
        const arrayBuffer = new ArrayBuffer(44 + dataLength);
        const view = new DataView(arrayBuffer);

        // WAV header
        this.writeStringToView(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataLength, true);
        this.writeStringToView(view, 8, 'WAVE');
        this.writeStringToView(view, 12, 'fmt ');
        view.setUint32(16, 16, true); // Subchunk1Size (16 для PCM)
        view.setUint16(20, format, true); // AudioFormat (1 = PCM)
        view.setUint16(22, numberOfChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true); // ByteRate
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitDepth, true);
        this.writeStringToView(view, 36, 'data');
        view.setUint32(40, dataLength, true);

        // Аудио данные
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