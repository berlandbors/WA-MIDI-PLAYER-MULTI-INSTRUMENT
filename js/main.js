import { Visualizer } from './visualizer.js';
import { MIDIPlayer } from './midi-player.js';
import { MIDIWriter } from './midi-writer.js';

// ===== UI ЛОГИКА =====
let player;
let visualizer;
let currentFileName = '';

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('canvas');
    const vizDebug = document.getElementById('vizDebug');
    visualizer = new Visualizer(canvas, vizDebug);
    player = new MIDIPlayer(visualizer);

    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const fileName = document.getElementById('fileName');
    const midiInfo = document.getElementById('midiInfo');
    const tempoInfo = document.getElementById('tempoInfo');
    const visualizerEl = document.getElementById('visualizer');
    const visualizationMode = document.getElementById('visualizationMode');
    const instrumentSelector = document.getElementById('instrumentSelector');
    const volumeControl = document.getElementById('volumeControl');
    const tempoControl = document.getElementById('tempoControl');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressFill = document.getElementById('progressFill');
    const currentTimeEl = document.getElementById('currentTime');
    const totalTimeEl = document.getElementById('totalTime');
    const playBtn = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const status = document.getElementById('status');
    const volumeSlider = document.getElementById('volumeSlider');
    const volumeValue = document.getElementById('volumeValue');
    const tempoSlider = document.getElementById('tempoSlider');
    const tempoValue = document.getElementById('tempoValue');

    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            const targetTab = tab.getAttribute('data-tab');
            document.getElementById(targetTab).classList.add('active');
        });
    });

    uploadArea.addEventListener('click', () => fileInput.click());

    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });

    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });

    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleFile(file);
    });

    function handleFile(file) {
        currentFileName = file.name;
        const reader = new FileReader();
        
        reader.onload = (e) => {
            try {
                const midiData = player.loadMIDI(e.target.result);
                
                fileName.textContent = file.name;
                fileInfo.classList.add('active');
                
                let infoText = `Формат: ${midiData.format}, Треков: ${midiData.trackCount}, `;
                infoText += `Разрешение: ${midiData.ticksPerBeat} ticks/beat`;
                
                if (midiData.isSMPTE) {
                    infoText += ` (SMPTE: ${midiData.framesPerSecond} fps)`;
                }
                
                midiInfo.textContent = infoText;
                
                if (midiData.tempoMap && midiData.tempoMap.length > 0) {
                    const firstTempo = midiData.tempoMap[0];
                    tempoInfo.textContent = `Темп: ${firstTempo.bpm.toFixed(2)} BPM (${firstTempo.microsecondsPerBeat} мкс/beat)`;
                    tempoInfo.style.display = 'block';
                }
                
                visualizerEl.classList.add('active');
                visualizationMode.classList.add('active');
                instrumentSelector.classList.add('active');
                volumeControl.classList.add('active');
                tempoControl.classList.add('active');
                progressContainer.classList.add('active');
                
                totalTimeEl.textContent = formatTime(player.duration);
                
                playBtn.disabled = false;
                pauseBtn.disabled = false;
                stopBtn.disabled = false;
                
                document.getElementById('exportJsonBtn').disabled = false;
                document.getElementById('exportWavBtn').disabled = false;
                document.getElementById('startRecordBtn').disabled = false;
                
                status.textContent = 'Файл загружен. Готов к воспроизведению.';
                
            } catch (error) {
                status.textContent = 'Ошибка: ' + error.message;
                console.error(error);
            }
        };
        
        reader.readAsArrayBuffer(file);
    }

    const vizBtns = document.querySelectorAll('.viz-btn');
    vizBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            vizBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            visualizer.setMode(btn.getAttribute('data-mode'));
        });
    });

    playBtn.addEventListener('click', async () => {
        await player.play(player.currentTime);
        status.textContent = 'Воспроизведение...';
    });

    pauseBtn.addEventListener('click', () => {
        player.pause();
        status.textContent = 'Пауза';
    });

    stopBtn.addEventListener('click', () => {
        player.stop();
        currentTimeEl.textContent = '0:00';
        progressFill.style.width = '0%';
        status.textContent = 'Остановлено';
    });

    volumeSlider.addEventListener('input', (e) => {
        const value = e.target.value;
        volumeValue.textContent = value + '%';
        player.setVolume(parseInt(value));
    });

    tempoSlider.addEventListener('input', (e) => {
        const value = e.target.value;
        tempoValue.textContent = value + '%';
        player.setTempo(parseInt(value));
    });

    setInterval(() => {
        if (player.isPlaying) {
            const progress = (player.currentTime / player.duration) * 100;
            progressFill.style.width = progress + '%';
            currentTimeEl.textContent = formatTime(player.currentTime);
        }
    }, 100);

    progressBar.addEventListener('click', (e) => {
        const rect = progressBar.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = x / rect.width;
        const time = percentage * player.duration;
        player.seek(time);
        progressFill.style.width = (percentage * 100) + '%';
        currentTimeEl.textContent = formatTime(time);
    });

    // ЭКСПОРТ JSON
    document.getElementById('exportJsonBtn').addEventListener('click', () => {
        const jsonData = player.exportToJSON();
        if (jsonData) {
            const jsonStr = JSON.stringify(jsonData, null, 2);
            document.getElementById('jsonOutput').value = jsonStr;
            document.getElementById('downloadJsonBtn').disabled = false;
        }
    });

    document.getElementById('downloadJsonBtn').addEventListener('click', () => {
        const jsonStr = document.getElementById('jsonOutput').value;
        const blob = new Blob([jsonStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = currentFileName.replace(/\.(mid|midi)$/i, '.json');
        a.click();
        URL.revokeObjectURL(url);
    });

    // ЭКСПОРТ WAV
    document.getElementById('exportWavBtn').addEventListener('click', async () => {
        const exportWavBtn = document.getElementById('exportWavBtn');
        const originalText = exportWavBtn.innerHTML;
        
        exportWavBtn.disabled = true;
        exportWavBtn.innerHTML = '<span>⏳</span> Рендеринг...';
        status.textContent = 'Рендеринг WAV файла...';
        
        try {
            const wavBlob = await player.exportToWAV();
            
            if (wavBlob) {
                const url = URL.createObjectURL(wavBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = currentFileName.replace(/\.(mid|midi)$/i, '.wav');
                a.click();
                URL.revokeObjectURL(url);
                
                status.textContent = '✅ WAV файл экспортирован успешно!';
            }
        } catch (error) {
            status.textContent = '❌ Ошибка экспорта: ' + error.message;
            console.error('Ошибка экспорта WAV:', error);
        } finally {
            exportWavBtn.disabled = false;
            exportWavBtn.innerHTML = originalText;
        }
    });

    // ЗАГРУЗКА JSON
    const jsonUploadArea = document.getElementById('jsonUploadArea');
    const jsonFileInput = document.getElementById('jsonFileInput');

    jsonUploadArea.addEventListener('click', () => jsonFileInput.click());

    jsonUploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        jsonUploadArea.classList.add('dragover');
    });

    jsonUploadArea.addEventListener('dragleave', () => {
        jsonUploadArea.classList.remove('dragover');
    });

    jsonUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        jsonUploadArea.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.type === 'application/json') {
            handleJSONFile(file);
        }
    });

    jsonFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) handleJSONFile(file);
    });

    function handleJSONFile(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            document.getElementById('jsonInput').value = e.target.result;
        };
        reader.readAsText(file);
    }

    // СОЗДАНИЕ MIDI
    document.getElementById('createMidiBtn').addEventListener('click', () => {
        try {
            const jsonStr = document.getElementById('jsonInput').value;
            const jsonData = JSON.parse(jsonStr);
            
            const writer = new MIDIWriter();
            const midiBytes = writer.createMIDI(jsonData);
            
            const blob = new Blob([midiBytes], { type: 'audio/midi' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'created.mid';
            a.click();
            URL.revokeObjectURL(url);
            
            document.getElementById('importStatus').textContent = '✅ MIDI файл создан и скачан!';
        } catch (error) {
            document.getElementById('importStatus').textContent = '❌ Ошибка: ' + error.message;
        }
    });

    document.getElementById('previewMidiBtn').addEventListener('click', () => {
        try {
            const jsonStr = document.getElementById('jsonInput').value;
            const jsonData = JSON.parse(jsonStr);
            
            const writer = new MIDIWriter();
            const midiBytes = writer.createMIDI(jsonData);
            
            player.loadMIDI(midiBytes.buffer);
            
            tabs[0].click();
            
            fileName.textContent = 'Предпросмотр созданного MIDI';
            fileInfo.classList.add('active');
            midiInfo.textContent = `Треков: ${jsonData.tracks.length}`;
            
            visualizerEl.classList.add('active');
            visualizationMode.classList.add('active');
            instrumentSelector.classList.add('active');
            volumeControl.classList.add('active');
            tempoControl.classList.add('active');
            progressContainer.classList.add('active');
            
            totalTimeEl.textContent = formatTime(player.duration);
            
            playBtn.disabled = false;
            pauseBtn.disabled = false;
            stopBtn.disabled = false;
            
            document.getElementById('importStatus').textContent = '✅ Предпросмотр готов!';
        } catch (error) {
            document.getElementById('importStatus').textContent = '❌ Ошибка: ' + error.message;
        }
    });

    // ЗАПИСЬ
    document.getElementById('startRecordBtn').addEventListener('click', async () => {
        await player.startRecording();
        document.getElementById('recordingIndicator').classList.add('active');
        document.getElementById('stopRecordBtn').disabled = false;
        document.getElementById('startRecordBtn').disabled = true;
        document.getElementById('recordStatus').textContent = 'Запись началась. Нажмите "Играть" для воспроизведения.';
    });

    document.getElementById('stopRecordBtn').addEventListener('click', async () => {
        const audioBlob = await player.stopRecording();
        if (audioBlob) {
            document.getElementById('recordingIndicator').classList.remove('active');
            document.getElementById('downloadAudioBtn').disabled = false;
            document.getElementById('stopRecordBtn').disabled = true;
            document.getElementById('startRecordBtn').disabled = false;
            
            document.getElementById('downloadAudioBtn').onclick = () => {
                const url = URL.createObjectURL(audioBlob);
                const a = document.createElement('a');
                a.href = url;
                a.download = currentFileName.replace(/\.(mid|midi)$/i, '.webm');
                a.click();
                URL.revokeObjectURL(url);
            };
            
            document.getElementById('recordStatus').textContent = '✅ Запись завершена. Нажмите "Скачать аудио".';
        }
    });

    window.addEventListener('resize', () => {
        visualizer.resize();
    });
});

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}