// ===== MIDI ПАРСЕР (УЛУЧШЕННЫЙ) =====
export class MIDIParser {
    constructor(arrayBuffer) {
        this.data = new DataView(arrayBuffer);
        this.pos = 0;
    }

    readString(length) {
        let str = '';
        for (let i = 0; i < length; i++) {
            str += String.fromCharCode(this.data.getUint8(this.pos++));
        }
        return str;
    }

    readUInt32() {
        const val = this.data.getUint32(this.pos);
        this.pos += 4;
        return val;
    }

    readUInt24() {
        const val = (this.data.getUint8(this.pos) << 16) |
                   (this.data.getUint8(this.pos + 1) << 8) |
                    this.data.getUint8(this.pos + 2);
        this.pos += 3;
        return val;
    }

    readUInt16() {
        const val = this.data.getUint16(this.pos);
        this.pos += 2;
        return val;
    }

    readUInt8() {
        return this.data.getUint8(this.pos++);
    }

    readVarLen() {
        let value = 0;
        let byte;
        do {
            byte = this.readUInt8();
            value = (value << 7) | (byte & 0x7f);
        } while (byte & 0x80);
        return value;
    }

    parse() {
        const header = this.readString(4);
        if (header !== 'MThd') {
            throw new Error('Неверный MIDI файл');
        }

        const headerLength = this.readUInt32();
        const format = this.readUInt16();
        const trackCount = this.readUInt16();
        const timeDivision = this.readUInt16();

        let ticksPerBeat = timeDivision;
        let isSMPTE = false;
        let framesPerSecond = 0;
        let ticksPerFrame = 0;

        if (timeDivision & 0x8000) {
            isSMPTE = true;
            framesPerSecond = -(timeDivision >> 8);
            ticksPerFrame = timeDivision & 0xFF;
            ticksPerBeat = framesPerSecond * ticksPerFrame;
        }

        const tracks = [];
        const tempoMap = [];

        for (let i = 0; i < trackCount; i++) {
            const track = this.parseTrack(tempoMap);
            if (track.events.length > 0) {
                tracks.push(track);
            }
        }

        return { 
            format, 
            trackCount, 
            timeDivision,
            ticksPerBeat,
            isSMPTE,
            framesPerSecond,
            ticksPerFrame,
            tempoMap,
            tracks 
        };
    }

    parseTrack(tempoMap) {
        const header = this.readString(4);
        if (header !== 'MTrk') {
            throw new Error('Неверный трек');
        }

        const trackLength = this.readUInt32();
        const trackEnd = this.pos + trackLength;
        const events = [];
        let runningStatus = 0;
        let absoluteTime = 0;

        while (this.pos < trackEnd) {
            const deltaTime = this.readVarLen();
            absoluteTime += deltaTime;

            let status = this.data.getUint8(this.pos);

            if (status < 0x80) {
                status = runningStatus;
            } else {
                this.pos++;
                if (status >= 0x80 && status < 0xF0) {
                    runningStatus = status;
                }
            }

            const eventType = status >> 4;
            const channel = status & 0x0F;

            if (eventType === 0x9) {
                const note = this.readUInt8();
                const velocity = this.readUInt8();
                if (velocity > 0) {
                    events.push({ type: 'noteOn', time: absoluteTime, note, velocity, channel });
                } else {
                    events.push({ type: 'noteOff', time: absoluteTime, note, channel });
                }
            }
            else if (eventType === 0x8) {
                const note = this.readUInt8();
                const velocity = this.readUInt8();
                events.push({ type: 'noteOff', time: absoluteTime, note, channel });
            }
            else if (eventType === 0xE) {
                const lsb = this.readUInt8();
                const msb = this.readUInt8();
                const value = (msb << 7) | lsb;
                events.push({ type: 'pitchBend', time: absoluteTime, value, channel });
            }
            else if (eventType === 0xC) {
                const program = this.readUInt8();
                events.push({ type: 'programChange', time: absoluteTime, program, channel });
            }
            else if (eventType === 0xB) {
                const controller = this.readUInt8();
                const value = this.readUInt8();
                events.push({ type: 'controlChange', time: absoluteTime, controller, value, channel });
            }
            else if (eventType === 0xD) {
                const pressure = this.readUInt8();
                events.push({ type: 'channelPressure', time: absoluteTime, pressure, channel });
            }
            else if (eventType === 0xA) {
                const note = this.readUInt8();
                const pressure = this.readUInt8();
                events.push({ type: 'polyPressure', time: absoluteTime, note, pressure, channel });
            }
            else if (status === 0xFF || status === 0xF0 || status === 0xF7) {
                if (status === 0xFF) {
                    const metaType = this.readUInt8();
                    const length = this.readVarLen();
                    
                    if (metaType === 0x51 && length === 3) {
                        const microsecondsPerBeat = this.readUInt24();
                        const bpm = 60000000 / microsecondsPerBeat;
                        tempoMap.push({
                            time: absoluteTime,
                            microsecondsPerBeat,
                            bpm
                        });
                        events.push({ 
                            type: 'tempo', 
                            time: absoluteTime, 
                            microsecondsPerBeat,
                            bpm
                        });
                    } else {
                        this.pos += length;
                    }
                } else {
                    const length = this.readVarLen();
                    this.pos += length;
                }
            }
        }

        return { events };
    }
}