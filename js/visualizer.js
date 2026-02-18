// ===== VISUALIZER (УЛУЧШЕННЫЙ) =====
export class Visualizer {
    constructor(canvas, debugEl) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', {
            alpha: false,
            desynchronized: true
        });
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this.debugEl = debugEl;
        this.mode = 'bars';
        this.activeNotes = new Map();
        this.bars = new Array(88).fill(0);
        this.smoothedBars = new Array(88).fill(0);
        this.noteCount = 0;
        this.isActive = false;
        this.lastTime = performance.now();
        this.frameCount = 0;
        this.fpsTime = 0;
        this.fps = 0;
        this.gradientCache = new Map();
        this.maxCacheSize = 50;
        this.TARGET_FRAME_TIME = 16.67;
        this.animationFrame = null;
        this.resize();
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = rect.width * dpr;
        this.canvas.height = rect.height * dpr;
        
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);
        
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        
        this.width = rect.width;
        this.height = rect.height;
        
        this.gradientCache.clear();
    }

    setMode(mode) {
        this.mode = mode;
        this.gradientCache.clear();
    }
    
    getOrCreateGradient(key, createFn) {
        if (!this.gradientCache.has(key)) {
            if (this.gradientCache.size >= this.maxCacheSize) {
                const firstKey = this.gradientCache.keys().next().value;
                this.gradientCache.delete(firstKey);
            }
            this.gradientCache.set(key, createFn());
        }
        return this.gradientCache.get(key);
    }

    addNote(note, velocity) {
        const index = note - 21;
        if (index >= 0 && index < 88) {
            this.activeNotes.set(note, { 
                velocity, 
                time: performance.now(),
                decaying: false
            });
            this.bars[index] = velocity;
            this.noteCount++;
            this.updateDebug();
        }
    }

    removeNote(note) {
        const noteData = this.activeNotes.get(note);
        if (noteData) {
            noteData.decaying = true;
            setTimeout(() => {
                this.activeNotes.delete(note);
                this.updateDebug();
            }, 200);
        }
    }

    updateDebug() {
        if (this.debugEl) {
            this.debugEl.textContent = `Активных: ${this.activeNotes.size} | Всего: ${this.noteCount} | FPS: ${this.fps}`;
        }
    }

    start() {
        if (this.isActive) return;
        this.isActive = true;
        this.lastTime = performance.now();
        this.animate();
    }

    stop() {
        this.isActive = false;
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
        this.activeNotes.clear();
        this.bars.fill(0);
        this.smoothedBars.fill(0);
        this.noteCount = 0;
        this.updateDebug();
        this.clear();
    }

    clear() {
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, this.width, this.height);
    }

    animate() {
        if (!this.isActive) return;

        const now = performance.now();
        const deltaTime = now - this.lastTime;
        this.lastTime = now;

        this.frameCount++;
        this.fpsTime += deltaTime;
        if (this.fpsTime >= 1000) {
            this.fps = Math.round((this.frameCount * 1000) / this.fpsTime);
            this.frameCount = 0;
            this.fpsTime = 0;
        }

        this.update(deltaTime);
        this.draw(now);
        
        this.animationFrame = requestAnimationFrame(() => this.animate());
    }

    update(deltaTime) {
        const decayRate = 0.95;
        const decayFactor = Math.pow(decayRate, deltaTime / this.TARGET_FRAME_TIME);
        const smoothingFactor = 0.15;
        
        for (let i = 0; i < this.bars.length; i++) {
            this.smoothedBars[i] += (this.bars[i] - this.smoothedBars[i]) * smoothingFactor;
            this.bars[i] *= decayFactor;
            if (this.bars[i] < 0.5) this.bars[i] = 0;
        }
        
        this.updateDebug();
    }

    draw(currentTime) {
        const { width, height } = this;
        
        this.ctx.fillStyle = '#ffffff';
        this.ctx.fillRect(0, 0, width, height);

        switch(this.mode) {
            case 'bars':
                this.drawBars();
                break;
            case 'wave':
                this.drawWave(currentTime);
                break;
            case 'circle':
                this.drawCircle();
                break;
        }
    }

    drawBars() {
        const { width, height } = this;
        const barCount = 88;
        const barWidth = width / barCount;
        
        // Рисуем сетку
        this.ctx.strokeStyle = 'rgba(102, 126, 234, 0.1)';
        this.ctx.lineWidth = 1;
        for (let i = 0; i < 4; i++) {
            const y = (height / 4) * i;
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(width, y);
            this.ctx.stroke();
        }
        
        // Рисуем столбцы
        for (let i = 0; i < barCount; i++) {
            const barHeight = (this.smoothedBars[i] / 127) * height * 0.9;
            
            if (barHeight > 1) {
                const hue = (i / barCount) * 280;
                
                // Тень
                this.ctx.fillStyle = `hsla(${hue}, 70%, 50%, 0.15)`;
                this.ctx.fillRect(i * barWidth + 1, height - barHeight + 3, barWidth - 2, barHeight);
                
                // Основной градиент
                const gradientKey = `bar-${Math.floor(barHeight / 10)}-${hue}`;
                const gradient = this.getOrCreateGradient(gradientKey, () => {
                    const g = this.ctx.createLinearGradient(0, height - barHeight, 0, height);
                    g.addColorStop(0, `hsl(${hue}, 85%, 65%)`);
                    g.addColorStop(1, `hsl(${hue}, 75%, 55%)`);
                    return g;
                });
                
                this.ctx.fillStyle = gradient;
                this.ctx.fillRect(i * barWidth + 1, height - barHeight, barWidth - 2, barHeight);
                
                // Блик сверху
                this.ctx.fillStyle = `hsla(${hue}, 100%, 85%, 0.8)`;
                this.ctx.fillRect(i * barWidth + 1, height - barHeight, barWidth - 2, 3);
            }
        }

        // Индикаторы активных нот
        this.activeNotes.forEach((data, note) => {
            const barIndex = note - 21;
            if (barIndex >= 0 && barIndex < barCount) {
                const x = barIndex * barWidth + barWidth / 2;
                const hue = (barIndex / barCount) * 280;
                
                this.ctx.strokeStyle = `hsla(${hue}, 100%, 50%, ${data.decaying ? 0.3 : 0.9})`;
                this.ctx.lineWidth = 2;
                this.ctx.beginPath();
                this.ctx.moveTo(x, height);
                this.ctx.lineTo(x, 10);
                this.ctx.stroke();
                
                this.ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
                this.ctx.beginPath();
                this.ctx.arc(x, 10, 4, 0, Math.PI * 2);
                this.ctx.fill();
            }
        });
    }

    drawWave(currentTime) {
        const { width, height } = this;
        const centerY = height / 2;
        
        // Центральная линия
        this.ctx.strokeStyle = 'rgba(102, 126, 234, 0.2)';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        this.ctx.moveTo(0, centerY);
        this.ctx.lineTo(width, centerY);
        this.ctx.stroke();
        
        // Расчет амплитуды
        let totalVelocity = 0;
        this.activeNotes.forEach(data => {
            totalVelocity += data.velocity;
        });
        const avgVelocity = this.activeNotes.size > 0 ? totalVelocity / this.activeNotes.size : 0;
        const amplitude = (avgVelocity / 127) * height * 0.35;

        this.ctx.beginPath();
        this.ctx.lineWidth = 4;
        
        const strokeGradient = this.getOrCreateGradient('wave-stroke', () => {
            const g = this.ctx.createLinearGradient(0, 0, width, 0);
            g.addColorStop(0, '#667eea');
            g.addColorStop(0.5, '#764ba2');
            g.addColorStop(1, '#f093fb');
            return g;
        });
        this.ctx.strokeStyle = strokeGradient;

        const points = 150;
        const step = width / points;
        const time = currentTime * 0.002;
        
        for (let i = 0; i <= points; i++) {
            const x = i * step;
            const barIndex = Math.floor((i / points) * this.smoothedBars.length);
            const barValue = this.smoothedBars[barIndex] / 127;
            
            const wave1 = Math.sin(i * 0.05 + time) * amplitude * 0.6;
            const wave2 = Math.sin(i * 0.1 - time * 1.5) * amplitude * 0.4;
            const barInfluence = barValue * height * 0.25;
            
            const y = centerY + wave1 + wave2 + barInfluence;
            
            if (i === 0) {
                this.ctx.moveTo(x, y);
            } else {
                this.ctx.lineTo(x, y);
            }
        }

        this.ctx.stroke();
        
        // Заливка под волной
        this.ctx.lineTo(width, height);
        this.ctx.lineTo(0, height);
        this.ctx.closePath();
        
        const fillGradientKey = `wave-fill-${Math.floor(amplitude / 10)}`;
        const fillGradient = this.getOrCreateGradient(fillGradientKey, () => {
            const g = this.ctx.createLinearGradient(0, centerY - amplitude, 0, height);
            g.addColorStop(0, 'rgba(102, 126, 234, 0.4)');
            g.addColorStop(1, 'rgba(118, 75, 162, 0.1)');
            return g;
        });
        this.ctx.fillStyle = fillGradient;
        this.ctx.fill();

        // Частицы активных нот
        this.activeNotes.forEach((data, note) => {
            const x = ((note - 21) / 88) * width;
            const y = centerY + Math.sin(currentTime * 0.005 + note) * amplitude;
            const hue = ((note - 21) / 88) * 280;
            
            this.ctx.shadowBlur = 15;
            this.ctx.shadowColor = `hsl(${hue}, 90%, 60%)`;
            
            this.ctx.beginPath();
            this.ctx.arc(x, y, data.decaying ? 3 : 6, 0, Math.PI * 2);
            this.ctx.fillStyle = `hsl(${hue}, 90%, 60%)`;
            this.ctx.fill();
            
            this.ctx.shadowBlur = 0;
        });
    }

    drawCircle() {
        const { width, height } = this;
        const centerX = width / 2;
        const centerY = height / 2;
        const minRadius = 30;
        const maxRadius = Math.max(Math.min(width, height) / 2 - 20, minRadius + 10);

        // Концентрические круги
        const layers = 4;
        for (let layer = 0; layer < layers; layer++) {
            const radius = minRadius + (maxRadius - minRadius) * ((layer + 1) / layers);
            
            this.ctx.beginPath();
            this.ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
            this.ctx.strokeStyle = `rgba(102, 126, 234, ${0.15 + layer * 0.05})`;
            this.ctx.lineWidth = 1;
            this.ctx.stroke();
        }

        // Лучи активных нот
        this.activeNotes.forEach((data, note) => {
            const angle = ((note - 21) / 88) * Math.PI * 2 - Math.PI / 2;
            const radius = minRadius + (data.velocity / 127) * (maxRadius - minRadius);
            const x = centerX + Math.cos(angle) * radius;
            const y = centerY + Math.sin(angle) * radius;
            const hue = ((note - 21) / 88) * 280;
            
            this.ctx.beginPath();
            this.ctx.moveTo(centerX, centerY);
            this.ctx.lineTo(x, y);
            this.ctx.strokeStyle = `hsla(${hue}, 85%, 55%, ${data.decaying ? 0.3 : 0.7})`;
            this.ctx.lineWidth = 3;
            this.ctx.stroke();
            
            this.ctx.shadowBlur = data.decaying ? 5 : 20;
            this.ctx.shadowColor = `hsl(${hue}, 90%, 60%)`;
            
            this.ctx.beginPath();
            this.ctx.arc(x, y, data.decaying ? 4 : 8, 0, Math.PI * 2);
            this.ctx.fillStyle = `hsl(${hue}, 90%, 60%)`;
            this.ctx.fill();
            
            this.ctx.shadowBlur = 0;
        });

        // Центральный круг
        const centerRadius = Math.max(25 + (this.activeNotes.size / 8) * 10, 15);
        this.ctx.beginPath();
        this.ctx.arc(centerX, centerY, centerRadius, 0, Math.PI * 2);
        
        const centerGradient = this.ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, centerRadius);
        centerGradient.addColorStop(0, '#764ba2');
        centerGradient.addColorStop(1, '#667eea');
        this.ctx.fillStyle = centerGradient;
        this.ctx.fill();

        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 3;
        this.ctx.stroke();

        // Счетчик нот
        this.ctx.fillStyle = 'white';
        this.ctx.font = 'bold 18px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(this.activeNotes.size, centerX, centerY);
    }
}