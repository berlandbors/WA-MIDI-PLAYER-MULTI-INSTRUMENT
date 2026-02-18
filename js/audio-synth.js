// ===== ГЕНЕРАЦИЯ ЗВУКА ПИАНИНО С ОПТИМИЗАЦИЕЙ =====

// Кэш семплов: Map<frequency, AudioBuffer>
const sampleCache = new Map();

// Экспортируемая функция для создания осциллятора (в будущем можно расширить)
export function createAdvancedOscillator(audioContext, frequency, type, time) {
    return createPiano(audioContext, frequency, time);
}

// Генерация семпла пианино с envelope и гармониками
function generatePianoSample(ctx, freq) {
    const sampleRate = ctx.sampleRate;
    const duration = 5; // Длительность семпла в секундах (достаточно для затухания)
    const length = Math.floor(sampleRate * duration);
    const buffer = ctx.createBuffer(1, length, sampleRate); // Моно
    const data = buffer.getChannelData(0);
    
    // Параметры
    const attackTime = 0.01; // Атака
    const decayTime = Math.max(2, 5 - Math.log10(freq / 100)); // Затухание: дольше для басов
    const harmonicFactor = Math.min(1, freq / 500); // Меньше гармоник для низких частот
    
    // Генерация волны
    for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        let sample = 0;
        
        // Envelope: атака + экспоненциальное затухание
        let envelope = 1;
        if (t < attackTime) {
            envelope = t / attackTime; // Линейная атака
        } else {
            const decayProgress = (t - attackTime) / decayTime;
            envelope = Math.exp(-decayProgress * 5); // Экспоненциальное затухание
        }
        if (envelope < 0.001) envelope = 0; // Обрезка для тишины
        
        // Основной тон + гармоники
        sample += Math.sin(2 * Math.PI * freq * t);
        sample += 0.3 * harmonicFactor * Math.sin(2 * Math.PI * freq * 2 * t);
        sample += 0.15 * harmonicFactor * Math.sin(2 * Math.PI * freq * 3 * t);
        sample += 0.08 * harmonicFactor * Math.sin(2 * Math.PI * freq * 4 * t);
        
        // Простой фильтр (lowpass approximation: уменьшаем верхние частоты)
        const filterFreq = Math.min(5000, 3000 + (freq / 1000) * 1000);
        const cutoff = filterFreq / (sampleRate / 2);
        const filterGain = 1 / (1 + (t * cutoff) ** 2); // Грубо имитируем фильтр
        sample *= filterGain;
        
        data[i] = sample * envelope * 0.5; // Нормализация громкости
    }
    
    return buffer;
}

// Функция создания звука пианино с использованием семпла
function createPiano(ctx, freq, time) {
    // Проверяем кэш
    if (!sampleCache.has(freq)) {
        sampleCache.set(freq, generatePianoSample(ctx, freq));
    }
    const buffer = sampleCache.get(freq);
    
    // Создаём источник из буфера
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    
    // Финальный gain для дополнительного контроля (если нужно)
    const postGain = ctx.createGain();
    postGain.gain.setValueAtTime(1.0, time);
    source.connect(postGain);
    
    return { 
        oscillator: source, // ПЕРЕИМЕНОВАНО: source → oscillator для совместимости
        gainNode: postGain, 
        extras: [], // Нет extras, так как всё в семпле
        duration: buffer.duration // ДОБАВЛЕНО: информация о длительности семпла
    };
}
