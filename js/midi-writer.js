// ===== MIDI WRITER =====
export class MIDIWriter {
    constructor() {
        this.data = [];
    }

    writeString(str) {
        for (let i = 0; i < str.length; i++) {
            this.data.push(str.charCodeAt(i));
        }
    }

    writeUInt32(value) {
        this.data.push((value >> 24) & 0xFF);
        this.data.push((value >> 16) & 0xFF);
        this.data.push((value >> 8) & 0xFF);
        this.data.push(value & 0xFF);
    }

    writeUInt16(value) {
        this.data.push((value >> 8) & 0xFF);
        this.data.push(value & 0xFF);
    }

    writeUInt8(value) {
        this.data.push(value & 0xFF);
    }

    writeVarLen(value) {
        const bytes = [];
        bytes.push(value & 0x7F);
        value >>= 7;
        while (value > 0) {
            bytes.push((value & 0x7F) | 0x80);
            value >>= 7;
        }
        for (let i = bytes.length - 1; i >= 0; i--) {
            this.data.push(bytes[i]);
        }
    }

    createMIDI(jsonData) {
        this.data = [];
        
        this.writeString('MThd');
        this.writeUInt32(6);
        this.writeUInt16(1);
        this.writeUInt16(jsonData.tracks.length);
        this.writeUInt16(480);

        jsonData.tracks.forEach(track => {
            this.writeTrack(track);
        });

        return new Uint8Array(this.data);
    }

    writeTrack(track) {
        const tempWriter = new MIDIWriter();
        
        const notes = [...track.notes].sort((a, b) => a.time - b.time);
        
        const events = [];
        notes.forEach(note => {
            const startTime = Math.round(note.time * 480);
            const endTime = Math.round((note.time + note.duration) * 480);
            
            events.push({
                time: startTime,
                type: 'noteOn',
                note: note.note,
                velocity: note.velocity || 100
            });
            
            events.push({
                time: endTime,
                type: 'noteOff',
                note: note.note
            });
        });
        
        events.sort((a, b) => a.time - b.time);
        
        let currentTime = 0;
        events.forEach(event => {
            const deltaTime = event.time - currentTime;
            tempWriter.writeVarLen(deltaTime);
            
            if (event.type === 'noteOn') {
                tempWriter.writeUInt8(0x90);
                tempWriter.writeUInt8(event.note);
                tempWriter.writeUInt8(event.velocity);
            } else {
                tempWriter.writeUInt8(0x80);
                tempWriter.writeUInt8(event.note);
                tempWriter.writeUInt8(0);
            }
            
            currentTime = event.time;
        });
        
        tempWriter.writeVarLen(0);
        tempWriter.writeUInt8(0xFF);
        tempWriter.writeUInt8(0x2F);
        tempWriter.writeUInt8(0x00);
        
        this.writeString('MTrk');
        this.writeUInt32(tempWriter.data.length);
        this.data.push(...tempWriter.data);
    }
}