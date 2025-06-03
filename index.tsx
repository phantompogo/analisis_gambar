
import { GoogleGenAI } from "@google/genai";

// Initialize the GoogleGenAI client with the API key from environment variables
// Ensure `process.env.API_KEY` is configured in your deployment environment.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const imageUploadInput = document.getElementById('imageUpload') as HTMLInputElement;
const fileUploadArea = document.getElementById('fileUploadArea') as HTMLDivElement;
const imagePreviewContainer = document.getElementById('imagePreviewContainer') as HTMLDivElement;
const imagePreview = document.getElementById('imagePreview') as HTMLImageElement;
const analyzeButton = document.getElementById('analyzeButton') as HTMLButtonElement;
const loadingSpinner = document.getElementById('loadingSpinner') as HTMLDivElement;
const multipleResultsContainer = document.getElementById('multipleResultsContainer') as HTMLDivElement;
const downloadAllButton = document.getElementById('downloadAllButton') as HTMLButtonElement;
const messageArea = document.getElementById('messageArea') as HTMLDivElement;
const greenScreenCheckbox = document.getElementById('greenScreenCheckbox') as HTMLInputElement;
const pngCheckbox = document.getElementById('pngCheckbox') as HTMLInputElement;
const animeModeCheckbox = document.getElementById('animeModeCheckbox') as HTMLInputElement;
const detailLevelSlider = document.getElementById('detailLevelSlider') as HTMLInputElement;
const detailLevelValueSpan = document.getElementById('detailLevelValue') as HTMLSpanElement;


let imageDataBase64: string | null = null;
let uploadedFileType: string | null = null; // Store the MIME type of the uploaded file
let originalFileExtension: string | null = null; // Store the original file extension
let allAnalysisResults: any[] = [];
let currentFile: File | null = null; // Store the currently handled file
let messageAreaTimeoutId: number | undefined = undefined;
let lastAnalysisSettings: { 
    isGreenScreen: boolean, 
    isPngMode: boolean, 
    isAnimeMode: boolean,
    detailLevel: number 
} | null = null;
let audioCtx: AudioContext | null = null; // Declare AudioContext

function playNotificationSound() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (!audioCtx) return; // AudioContext not supported

    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.type = 'sine'; // Sine wave for a clean tone
    oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // A higher pitch (A5)
    gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime); // Start with some volume

    // Create a short "ding" effect
    gainNode.gain.exponentialRampToValueAtTime(0.00001, audioCtx.currentTime + 0.5); // Fade out quickly

    oscillator.start(audioCtx.currentTime);
    oscillator.stop(audioCtx.currentTime + 0.5); // Stop after 0.5 seconds
}

// Update detail level display
if (detailLevelSlider && detailLevelValueSpan) {
    detailLevelSlider.addEventListener('input', () => {
        detailLevelValueSpan.textContent = detailLevelSlider.value;
    });
}


fileUploadArea.addEventListener('click', () => imageUploadInput.click());

imageUploadInput.addEventListener('change', (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
        handleFile(target.files[0]);
    } else {
        handleFile(null);
    }
});

function handleFile(file: File | null) {
    currentFile = file; // Store the file
    if (file) {
        // Increased max file size to 4MB for image data as Gemini can handle it.
        // The actual limit might be lower based on base64 encoding overhead.
        // For Gemini API, image part size limit is 4MB (bytes of the image itself)
        if (file.size > 4 * 1024 * 1024) {
            showMessage('Ukuran file terlalu besar. Maksimal 4MB.', 'error');
            resetImageUpload();
            return;
        }
        const reader = new FileReader();
        reader.onload = (e: ProgressEvent<FileReader>) => {
            if (e.target && typeof e.target.result === 'string') {
                imagePreview.src = e.target.result;
                imagePreviewContainer.classList.remove('hidden');
                imageDataBase64 = e.target.result.split(',')[1];
                uploadedFileType = file.type; // Store the actual MIME type

                const fileNameParts = file.name.split('.');
                if (fileNameParts.length > 1) {
                    originalFileExtension = fileNameParts.pop()?.toLowerCase() || null;
                } else {
                    originalFileExtension = uploadedFileType ? uploadedFileType.split('/')[1] : null;
                }

                analyzeButton.disabled = false;
                multipleResultsContainer.innerHTML = '';
                downloadAllButton.classList.add('hidden');
                downloadAllButton.disabled = true;
                allAnalysisResults = [];
                hideMessage();
            } else {
                showMessage('Gagal membaca file.', 'error');
                resetImageUpload();
            }
        }
        reader.readAsDataURL(file);
    } else {
        resetImageUpload();
    }
}

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    fileUploadArea.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e: Event) {
    e.preventDefault();
    e.stopPropagation();
}

fileUploadArea.addEventListener('dragenter', () => fileUploadArea.classList.add('drag-over'), false);
fileUploadArea.addEventListener('dragleave', () => fileUploadArea.classList.remove('drag-over'), false);
fileUploadArea.addEventListener('dragover', () => fileUploadArea.classList.add('drag-over'), false);

fileUploadArea.addEventListener('drop', (e: DragEvent) => {
    fileUploadArea.classList.remove('drag-over');
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length > 0) {
        const files = dt.files;
        handleFile(files[0]);
        // Do not try to set imageUploadInput.files, it's read-only and not needed here
    }
}, false);

function resetImageUpload() {
    imageUploadInput.value = '';
    imagePreview.src = '#';
    imagePreviewContainer.classList.add('hidden');
    imageDataBase64 = null;
    uploadedFileType = null;
    originalFileExtension = null; // Reset file extension
    currentFile = null; // Reset stored file
    analyzeButton.disabled = true;
    multipleResultsContainer.innerHTML = '';
    downloadAllButton.classList.add('hidden');
    downloadAllButton.disabled = true;
    allAnalysisResults = [];
    greenScreenCheckbox.checked = false;
    pngCheckbox.checked = false;
    animeModeCheckbox.checked = false;
    if (detailLevelSlider) detailLevelSlider.value = "3"; // Reset slider to default
    if (detailLevelValueSpan) detailLevelValueSpan.textContent = "3"; // Reset slider display
    lastAnalysisSettings = null;
}

async function callGeminiForFeature(promptText: string, featureType: string, resultIndex: number) {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-04-17',
            contents: promptText,
        });
        const llmOutput = response.text;

        if (allAnalysisResults[resultIndex]) {
            if (featureType === 'contentIdeas') {
                allAnalysisResults[resultIndex].creative_content_ideas = llmOutput;
            } else if (featureType === 'expandKeywords') {
                allAnalysisResults[resultIndex].expanded_keywords_text = llmOutput;
            }
        }
        return llmOutput;
    } catch (error: any) {
        console.error(`Error calling Gemini for ${featureType}:`, error);
        showMessage(`Gagal mendapatkan ${featureType === 'contentIdeas' ? 'ide konten' : 'perluasan kata kunci'}. Error: ${error.message}`, 'error');
        return null;
    }
}

analyzeButton.addEventListener('click', async function () {
    if (!imageDataBase64 || !uploadedFileType) {
        showMessage('Silakan pilih gambar terlebih dahulu.', 'error');
        return;
    }

    loadingSpinner.classList.remove('hidden');
    multipleResultsContainer.innerHTML = '';
    downloadAllButton.classList.add('hidden');
    downloadAllButton.disabled = true;
    analyzeButton.disabled = true;
    hideMessage();
    allAnalysisResults = [];

    const isGreenScreen = greenScreenCheckbox.checked;
    const isPngMode = pngCheckbox.checked;
    const isAnimeMode = animeModeCheckbox.checked;
    const currentDetailLevel = parseInt(detailLevelSlider.value);

    lastAnalysisSettings = {
        isGreenScreen,
        isPngMode,
        isAnimeMode,
        detailLevel: currentDetailLevel
    };

    let animeModeInstruction = "";
    if (isAnimeMode) {
        animeModeInstruction = " If 'Anime Mode' is active, ensure the description prominently features 'Anime style' or related terms like 'anime character'.";
    }
    
    let detailInstruction = "";
    let keywordCountInstruction = "20-35"; // Default for level 3
    let descriptionLengthInstruction = "8-15 words"; // Default for level 3

    switch (currentDetailLevel) {
        case 1:
            descriptionLengthInstruction = "5-8 words (very concise)";
            keywordCountInstruction = "10-15 (highly specific core keywords)";
            detailInstruction = `Provide a very concise description (${descriptionLengthInstruction}) and ${keywordCountInstruction} highly specific core keywords.`;
            break;
        case 2:
            descriptionLengthInstruction = "7-12 words (concise)";
            keywordCountInstruction = "15-20 (specific keywords)";
            detailInstruction = `Provide a concise description (${descriptionLengthInstruction}) and ${keywordCountInstruction} specific keywords.`;
            break;
        case 3: // Default
            descriptionLengthInstruction = "8-15 words (standard)";
            keywordCountInstruction = "20-35 (relevant keywords)";
            detailInstruction = `Provide a standard description (${descriptionLengthInstruction}) and ${keywordCountInstruction} relevant keywords.`;
            break;
        case 4:
            descriptionLengthInstruction = "12-18 words (more detailed)";
            keywordCountInstruction = "30-40 (keywords, including some broader concepts)";
            detailInstruction = `Provide a more detailed description (${descriptionLengthInstruction}), including subtle observations, and ${keywordCountInstruction} keywords, including some broader concepts.`;
            break;
        case 5:
            descriptionLengthInstruction = "15-25 words (highly detailed)";
            keywordCountInstruction = "35-50 (keywords, including abstract concepts and related themes)";
            detailInstruction = `Provide a highly detailed and nuanced description (${descriptionLengthInstruction}), capturing subtle elements and potential interpretations, and ${keywordCountInstruction} keywords, including abstract concepts and related themes.`;
            break;
    }


    let coreAnalysisPrompt: string;
    if (isGreenScreen) {
        coreAnalysisPrompt = `You are an expert in creating metadata for stock video footage, especially green screen footage.
Analyze the provided image (which represents a frame from a green screen video). If you can identify multiple distinct subjects, provide a separate analysis for each.
For each identified subject:
1.  **Description (Title):** ${detailInstruction} Focus on actions, concepts, number of people, gender, ethnicity, and suitability for compositing. Ensure the description clearly indicates it's for "green screen" footage.${animeModeInstruction} Example (for standard detail): "Man in business suit pointing upwards, green screen video footage."
2.  **Keywords:** ${keywordCountInstruction} keywords. Include "green screen," "chroma key," "video footage," "isolated," actions, concepts, and subject details.
Output format: JSON array of objects. Each object: { "subject_focus": "Short identifier in English", "description": "Description in English matching the detail level requested", "keywords": ["keyword1 in English", "..."] }
Ensure all text output is in English.`;
    } else {
        coreAnalysisPrompt = `You are a professional image analyst specializing in creating SEO-optimized stock photo metadata.
Analyze the provided image. If you can identify multiple distinct objects or subjects, provide a separate analysis for each.
For each identified object/subject:
1.  **Description (Title):** ${detailInstruction} Max 200 chars. ${animeModeInstruction} Example (for standard detail): "Gray and white Maine Coon cat on red velvet sofa, looking curious."
2.  **Keywords:** ${keywordCountInstruction} most relevant, specific, descriptive keywords, ordered by importance.
Output format: JSON array of objects. Each object: { "subject_focus": "Short identifier in English", "description": "Description in English matching the detail level requested", "keywords": ["keyword1 in English", "..."] }
Ensure all text output is in English.`;
    }

    try {
        const textPart = { text: coreAnalysisPrompt };
        const imagePart = { inlineData: { mimeType: uploadedFileType, data: imageDataBase64 } };

        const genAIResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash-preview-04-17',
            contents: { parts: [textPart, imagePart] }, // Use {parts: [...]} for multimodal
            config: { responseMimeType: "application/json" }
        });
        
        let responseText = genAIResponse.text;
        const fenceRegex = /^```(\w*)?\s*\n?(.*?)\n?\s*```$/s;
        const match = responseText.match(fenceRegex);
        if (match && match[2]) {
            responseText = match[2].trim();
        }

        let parsedResults;
        try {
            parsedResults = JSON.parse(responseText);
        } catch (e) {
            console.error("Failed to parse JSON from core analysis:", e, "Raw text:", responseText);
            throw new Error(`Gagal memproses respons dari analisis inti. Respons tidak valid: ${responseText.substring(0,100)}...`);
        }

        if (isPngMode && !isGreenScreen && uploadedFileType === 'image/png' && Array.isArray(parsedResults)) {
            parsedResults.forEach(item => {
                const pngKeyword = "isolated on transparent background";
                if (item.keywords && Array.isArray(item.keywords)) {
                    if (!item.keywords.map(kw => kw.toLowerCase()).includes(pngKeyword.toLowerCase())) {
                        item.keywords.push(pngKeyword);
                    }
                } else {
                    item.keywords = [pngKeyword];
                }
                if (item.description) {
                    let desc = item.description.trim();
                    const phraseToAdd = "isolated on transparent background";
                    if (!desc.toLowerCase().includes(phraseToAdd.toLowerCase())) {
                        if (desc.endsWith('.')) {
                            desc = desc.slice(0, -1).trim();
                        }
                        item.description = (desc ? desc + " " : "") + phraseToAdd + ".";
                    }
                } else {
                    item.description = "Object isolated on transparent background.";
                }
            });
        }

        if (isAnimeMode && Array.isArray(parsedResults)) {
            parsedResults.forEach(item => {
                const animeTerms = ["anime style", "anime character", "anime artwork", "anime art", "anime illustration"];
                let currentDescription = item.description || "";
                const descriptionLower = currentDescription.toLowerCase();
                let hasAnimeTerm = animeTerms.some(term => descriptionLower.includes(term));

                if (!hasAnimeTerm) {
                    let desc = currentDescription.trim();
                    const phraseToAdd = "Anime style";
                    if (desc.endsWith('.')) {
                        desc = desc.slice(0, -1).trim(); 
                    }
                    if (desc) {
                        item.description = desc + (desc.endsWith(',') || desc.endsWith(';') ? " " : ", ") + phraseToAdd + ".";
                    } else {
                        item.description = "Subject in " + phraseToAdd + ".";
                    }
                } else {
                    // If it has an anime term but doesn't end with a period, add one.
                    if (currentDescription.trim() && !currentDescription.trim().endsWith('.')) {
                        item.description = currentDescription.trim() + ".";
                    }
                }
            });
        }

        // Remove trailing periods from all descriptions AFTER all mode modifications
        if (Array.isArray(parsedResults)) {
            parsedResults.forEach(item => {
                if (item.description && typeof item.description === 'string') {
                    let currentDesc = item.description.trimRight(); // Trim whitespace from the end
                    if (currentDesc.endsWith('.')) {
                        item.description = currentDesc.slice(0, -1); // Remove the period
                    } else {
                        item.description = currentDesc; // Assign back the right-trimmed version
                    }
                }
            });
        }
        
        allAnalysisResults = parsedResults;

        if (Array.isArray(allAnalysisResults) && allAnalysisResults.length > 0) {
            allAnalysisResults.forEach((item, index) => {
                const card = document.createElement('div');
                card.className = 'result-card';
                card.dataset.resultIndex = String(index);

                const objectNameBox = document.createElement('div');
                objectNameBox.className = 'object-name-box';

                const objectNameText = document.createElement('span');
                objectNameText.className = 'object-name-text';
                objectNameText.textContent = item.subject_focus || `Hasil Analisis ${index + 1}`;

                const objectNumberText = document.createElement('span');
                objectNumberText.className = 'object-number-text';
                objectNumberText.textContent = ` (#${index + 1})`; 

                objectNameBox.appendChild(objectNameText);
                objectNameBox.appendChild(objectNumberText); 
                card.appendChild(objectNameBox);

                const descriptionBlock = document.createElement('div');
                descriptionBlock.className = 'content-block';
                const descriptionP = document.createElement('p');
                descriptionP.innerHTML = `<strong>Description:</strong><br><span class="text-to-copy" id="desc-${index}">${item.description || 'No description generated'}</span>`;
                descriptionBlock.appendChild(descriptionP);
                
                // Create and append Copy Description button directly to descriptionBlock
                const copyDescButton = createActionButton(`desc-${index}`, 'Deskripsi', 'copy', item.description || '');
                copyDescButton.style.marginTop = '0.5rem'; // Add some space above the button
                descriptionBlock.appendChild(copyDescButton);
                card.appendChild(descriptionBlock);


                const keywordsBlock = document.createElement('div');
                keywordsBlock.className = 'content-block';
                const keywordsP = document.createElement('p');
                const keywordsString = item.keywords && item.keywords.length > 0 ? item.keywords.join(', ') : 'No keywords generated';
                keywordsP.innerHTML = `<strong>Keywords:</strong><br><span class="text-to-copy" id="kw-${index}">${keywordsString}</span>`;
                keywordsBlock.appendChild(keywordsP);
                card.appendChild(keywordsBlock);

                // ActionButtonsContainer will now only hold the Copy Keywords button
                const actionButtonsContainer = document.createElement('div');
                actionButtonsContainer.className = 'action-buttons-container';
                const copyKwButton = createActionButton(`kw-${index}`, 'Kata Kunci', 'copy', keywordsString);
                actionButtonsContainer.appendChild(copyKwButton);
                card.appendChild(actionButtonsContainer);

                const llmFeaturesContainer = document.createElement('div');
                llmFeaturesContainer.className = 'llm-features-container mt-4 pt-4 border-t border-slate-700';
                const contentIdeasButton = document.createElement('button');
                contentIdeasButton.className = 'btn-llm';
                contentIdeasButton.innerHTML = `<i class="fas fa-lightbulb"></i> ✨ Hasilkan Ide Konten`;
                contentIdeasButton.dataset.index = String(index);
                contentIdeasButton.onclick = handleGenerateContentIdeas;
                llmFeaturesContainer.appendChild(contentIdeasButton);
                const contentIdeasOutputArea = document.createElement('div');
                contentIdeasOutputArea.id = `content-ideas-output-${index}`;
                contentIdeasOutputArea.className = 'llm-feature-block output-area mt-2 hidden';
                llmFeaturesContainer.appendChild(contentIdeasOutputArea);
                const contentIdeasSpinner = document.createElement('div');
                contentIdeasSpinner.id = `content-ideas-spinner-${index}`;
                contentIdeasSpinner.className = 'llm-loading-spinner hidden';
                llmFeaturesContainer.appendChild(contentIdeasSpinner);

                const expandKeywordsButton = document.createElement('button');
                expandKeywordsButton.className = 'btn-llm';
                expandKeywordsButton.innerHTML = `<i class="fas fa-tags"></i> ✨ Perluas Kata Kunci`;
                expandKeywordsButton.dataset.index = String(index);
                expandKeywordsButton.onclick = handleExpandKeywords;
                llmFeaturesContainer.appendChild(expandKeywordsButton);
                const expandKeywordsOutputArea = document.createElement('div');
                expandKeywordsOutputArea.id = `expand-keywords-output-${index}`;
                expandKeywordsOutputArea.className = 'llm-feature-block output-area mt-2 hidden';
                llmFeaturesContainer.appendChild(expandKeywordsOutputArea);
                const expandKeywordsSpinner = document.createElement('div');
                expandKeywordsSpinner.id = `expand-keywords-spinner-${index}`;
                expandKeywordsSpinner.className = 'llm-loading-spinner hidden';
                llmFeaturesContainer.appendChild(expandKeywordsSpinner);

                card.appendChild(llmFeaturesContainer);
                multipleResultsContainer.appendChild(card);
            });
            downloadAllButton.classList.remove('hidden');
            downloadAllButton.disabled = false;
        } else {
            showMessage('Tidak ada objek yang dapat dianalisis atau format respons tidak sesuai.', 'info');
        }
    } catch (error: any) {
        console.error('Error in main analysis:', error);
        showMessage(`Terjadi kesalahan saat analisis utama: ${error.message}`, 'error');
    } finally {
        loadingSpinner.classList.add('hidden');
        analyzeButton.disabled = false;
        playNotificationSound(); // Play sound when analysis is complete
    }
});

async function handleGenerateContentIdeas(event: MouseEvent) {
    const button = event.currentTarget as HTMLButtonElement;
    const resultIndex = parseInt(button.dataset.index || "0");
    const resultItem = allAnalysisResults[resultIndex];
    if (!resultItem) return;

    const outputArea = document.getElementById(`content-ideas-output-${resultIndex}`) as HTMLDivElement;
    const spinner = document.getElementById(`content-ideas-spinner-${resultIndex}`) as HTMLDivElement;
    outputArea.classList.add('hidden');
    spinner.classList.remove('hidden');
    button.disabled = true;

    let contextInfo = `Description: "${resultItem.description}"\nKeywords: ${resultItem.keywords.join(', ')}`;
    if (lastAnalysisSettings?.isGreenScreen) {
        contextInfo += "\nContext: This is for green screen video footage.";
    }
    if (lastAnalysisSettings?.isAnimeMode) {
        contextInfo += "\nContext: This is Anime style artwork/content.";
    }
    if (lastAnalysisSettings?.detailLevel) {
         contextInfo += `\n(Original analysis was generated with detail level: ${lastAnalysisSettings.detailLevel})`;
    }
    const promptText = `Based on the following image/video analysis:\n${contextInfo}\n\nGenerate 3-5 creative content ideas in English. These could be blog post titles, social media captions, or short story prompts. Present them as a numbered list.`;
    const ideas = await callGeminiForFeature(promptText, 'contentIdeas', resultIndex);

    spinner.classList.add('hidden');
    if (ideas) {
        outputArea.textContent = ideas;
        outputArea.classList.remove('hidden');
    } else {
        outputArea.textContent = 'Failed to generate content ideas.';
        outputArea.classList.remove('hidden'); // Show area even on failure
    }
    button.disabled = false;
}

async function handleExpandKeywords(event: MouseEvent) {
    const button = event.currentTarget as HTMLButtonElement;
    const resultIndex = parseInt(button.dataset.index || "0");
    const resultItem = allAnalysisResults[resultIndex];
    if (!resultItem) return;

    const outputArea = document.getElementById(`expand-keywords-output-${resultIndex}`) as HTMLDivElement;
    const spinner = document.getElementById(`expand-keywords-spinner-${resultIndex}`) as HTMLDivElement;
    outputArea.innerHTML = '';
    outputArea.classList.add('hidden');
    spinner.classList.remove('hidden');
    button.disabled = true;

    let contextInfo = `Primary keywords for an image/video: ${resultItem.keywords.join(', ')}\nDescription: "${resultItem.description}"`;
    if (lastAnalysisSettings?.isGreenScreen) {
        contextInfo += "\nContext: This is for green screen video footage. Suggest keywords suitable for video compositing and general video themes.";
    }
    if (lastAnalysisSettings?.isAnimeMode) {
        contextInfo += "\nContext: This is Anime style artwork/content. Suggest keywords related to anime genres, styles, or character tropes if applicable.";
    }
    if (lastAnalysisSettings?.detailLevel) {
         contextInfo += `\n(Original analysis was generated with detail level: ${lastAnalysisSettings.detailLevel})`;
    }

    const promptText = `Given the following:\n${contextInfo}\n\nSuggest 10-15 additional related or semantic keywords in English that would be useful for broader reach or conceptual understanding. Provide them as a comma-separated list.`;
    const expandedKeywordsText = await callGeminiForFeature(promptText, 'expandKeywords', resultIndex);

    spinner.classList.add('hidden');
    if (expandedKeywordsText) {
        const keywordsArray = expandedKeywordsText.split(',').map(kw => kw.trim()).filter(kw => kw);
        if (keywordsArray.length > 0) {
            keywordsArray.forEach(kw => {
                const tag = document.createElement('span');
                tag.className = 'keyword-tag-llm';
                tag.textContent = kw;
                outputArea.appendChild(tag);
            });
            if (allAnalysisResults[resultIndex]) {
                allAnalysisResults[resultIndex].expanded_keywords_array = keywordsArray;
            }
        } else {
             outputArea.textContent = 'No additional keywords generated.';
        }
        outputArea.classList.remove('hidden');
    } else {
        outputArea.textContent = 'Failed to expand keywords.';
        outputArea.classList.remove('hidden'); // Show area even on failure
    }
    button.disabled = false;
}


downloadAllButton.addEventListener('click', function () {
    if (allAnalysisResults.length === 0) {
        showMessage('Tidak ada hasil analisis untuk diunduh.', 'info');
        return;
    }
    let combinedContent = "Image/Video Analysis Results:\n";
    if (lastAnalysisSettings) {
        if (lastAnalysisSettings.isGreenScreen) {
            combinedContent += "Mode: Green Screen Video\n";
        } else if (lastAnalysisSettings.isPngMode && (uploadedFileType === 'image/png')) {
            combinedContent += "Mode: PNG (Isolated on Transparent Background considerations applied)\n";
        } else {
            combinedContent += "Mode: Standard Image Analysis\n";
        }
        if (lastAnalysisSettings.isAnimeMode) {
            combinedContent += "Mode Consideration: Anime\n";
        }
        combinedContent += `Analysis Detail Level: ${lastAnalysisSettings.detailLevel}\n`;
    } else {
         combinedContent += "Mode: Standard Image Analysis (default)\n"; // Fallback if settings somehow not captured
         combinedContent += `Analysis Detail Level: 3 (default)\n`;
    }
    combinedContent += "\n========================================\n\n";

    allAnalysisResults.forEach((item, index) => {
        const subjectFocus = item.subject_focus || `Analysis Result ${index + 1}`;
        const description = item.description || "N/A"; // This will use the period-less description
        const keywords = item.keywords && item.keywords.length > 0 ? item.keywords.join(', ') : "N/A";

        combinedContent += `Result ${index + 1}:\n`;
        combinedContent += `Subject Focus: ${subjectFocus}`;
        if (originalFileExtension) {
            combinedContent += ` (.${originalFileExtension})`; // Still keep original extension in download
        }
        combinedContent += `\n`;
        combinedContent += `Description: ${description}\n`;
        combinedContent += `Keywords: ${keywords}\n`;

        if (item.creative_content_ideas) {
            combinedContent += `\nCreative Content Ideas:\n${item.creative_content_ideas}\n`;
        }
        if (item.expanded_keywords_array && item.expanded_keywords_array.length > 0) {
            combinedContent += `\nExpanded Keywords: ${item.expanded_keywords_array.join(', ')}\n`;
        }
        combinedContent += "\n----------------------------------------\n\n";
    });

    const originalFileName = currentFile ? currentFile.name.split('.')[0] : 'all_analysis_results';
    const filename = `${originalFileName}_full_analysis.txt`;

    const blob = new Blob([combinedContent], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    showMessage(`File ${filename} berhasil diunduh!`, 'success');
});

function createActionButton(targetIdOrData: string, typeName: string, actionType: string, textToCopy: string) {
    const button = document.createElement('button');
    button.className = 'btn-action';
    let iconClass = 'fas fa-copy';
    button.innerHTML = `<i class="${iconClass}"></i> Salin ${typeName}`;
    button.addEventListener('click', () => {
        const textElement = document.getElementById(targetIdOrData);
        // Ensure textToCopy is used if element not found or if it's explicitly passed for direct copy
        const text = textElement ? textElement.innerText : textToCopy; 
        copyToClipboard(text, typeName);
    });
    return button;
}

function copyToClipboard(text: string, typeName: string) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        showMessage(`${typeName} berhasil disalin ke clipboard!`, 'success');
    } catch (err) {
        showMessage(`Gagal menyalin ${typeName}.`, 'error');
        console.error('Gagal menyalin teks: ', err);
    }
    document.body.removeChild(textarea);
}

type MessageType = 'info' | 'error' | 'success';

function showMessage(message: string, type: MessageType = 'info') {
    messageArea.textContent = message;
    messageArea.classList.remove('hidden', 'message-box-error', 'message-box-info', 'message-box-success');
    messageArea.classList.add(`message-box-${type}`);
    
    if (messageAreaTimeoutId !== undefined) {
        clearTimeout(messageAreaTimeoutId);
    }
    messageAreaTimeoutId = window.setTimeout(() => {
        hideMessage();
        messageAreaTimeoutId = undefined;
    }, 3000);
}
function hideMessage() { messageArea.classList.add('hidden'); }