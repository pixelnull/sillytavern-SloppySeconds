// ============================================================================
// Settings UI
// ============================================================================

import { saveSettingsDebounced } from '../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import { getSettings, defaultSettings } from '../settings.js';
import {
    processingMessageId,
    obsidianPatternsLoaded, setObsidianPatternsLoaded,
} from './state.js';
import { callViaProfile, analyzeText } from './ai.js';
import { callViaCorsBridge } from './proxy-api.js';
import { obsidianFetch } from './obsidian-api.js';
import { loadObsidianPatterns, seedObsidianPatterns } from './patterns.js';
import { findLastAiMessage, buildFindingsHtml } from './ui.js';

export function loadSettingsUI() {
    const s = getSettings();

    $('#ss_enabled').prop('checked', s.enabled);
    $('#ss_auto_refine').prop('checked', s.autoRefine);
    $('#ss_connection_mode').val(s.connectionMode);
    $('#ss_proxy_url').val(s.proxyUrl);
    $('#ss_model').val(s.model);
    $('#ss_max_tokens').val(s.maxTokens);
    $('#ss_thinking_budget').val(s.thinkingBudget);
    $('#ss_timeout').val(s.timeout);
    $('#ss_obsidian_enabled').prop('checked', s.obsidianEnabled);
    $('#ss_obsidian_port').val(s.obsidianPort);
    $('#ss_obsidian_api_key').val(s.obsidianApiKey);
    $('#ss_pattern_file').val(s.patternFile);
    $('#ss_custom_patterns').val(s.customPatterns);
    $('#ss_context_ai_messages').val(s.contextAiMessages);
    $('#ss_refine_group').val(s.refineGroupMessages || 'all');
    $('#ss_confidence_threshold').val(s.autoApplyThreshold ?? 0.7);
    $('#ss_show_clean_badges').prop('checked', s.showCleanBadges);
    $('#ss_system_prompt').val(s.systemPrompt);
    $('#ss_debug_mode').prop('checked', s.debugMode);

    // Load category toggles
    if (s.enabledCategories) {
        $('.ss_category_toggle').each(function () {
            const cat = $(this).data('category');
            $(this).prop('checked', s.enabledCategories[cat] !== false);
        });
    }

    updateConnectionVisibility();
    populateProfileDropdown();
}

export function bindSettingsEvents() {
    // Checkboxes
    $('#ss_enabled').on('change', function () {
        getSettings().enabled = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#ss_auto_refine').on('change', function () {
        getSettings().autoRefine = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#ss_obsidian_enabled').on('change', function () {
        getSettings().obsidianEnabled = $(this).is(':checked');
        saveSettingsDebounced();
        setObsidianPatternsLoaded(false); // Force reload
    });
    $('#ss_show_clean_badges').on('change', function () {
        const checked = $(this).is(':checked');
        getSettings().showCleanBadges = checked;
        saveSettingsDebounced();
        if (!checked) $('.ss_result_badge.ss_clean').remove();
    });
    $('#ss_debug_mode').on('change', function () {
        getSettings().debugMode = $(this).is(':checked');
        saveSettingsDebounced();
    });

    // Category toggles
    $(document).on('change', '.ss_category_toggle', function () {
        const cat = $(this).data('category');
        const s = getSettings();
        if (!s.enabledCategories) s.enabledCategories = {};
        s.enabledCategories[cat] = $(this).is(':checked');
        saveSettingsDebounced();
    });

    // Connection mode
    $('#ss_connection_mode').on('change', function () {
        getSettings().connectionMode = $(this).val();
        saveSettingsDebounced();
        updateConnectionVisibility();
    });

    // Profile dropdown
    $('#ss_profile_select').on('change', function () {
        getSettings().profileId = $(this).val();
        saveSettingsDebounced();
    });

    // Group chat refinement
    $('#ss_refine_group').on('change', function () {
        getSettings().refineGroupMessages = $(this).val();
        saveSettingsDebounced();
    });

    // Text inputs
    const textFields = {
        '#ss_proxy_url': 'proxyUrl',
        '#ss_model': 'model',
        '#ss_obsidian_api_key': 'obsidianApiKey',
        '#ss_pattern_file': 'patternFile',
        '#ss_custom_patterns': 'customPatterns',
        '#ss_system_prompt': 'systemPrompt',
    };
    for (const [selector, key] of Object.entries(textFields)) {
        $(selector).on('input', function () {
            getSettings()[key] = $(this).val();
            saveSettingsDebounced();
        });
    }

    // Number inputs
    const numFields = {
        '#ss_max_tokens': 'maxTokens',
        '#ss_thinking_budget': 'thinkingBudget',
        '#ss_timeout': 'timeout',
        '#ss_obsidian_port': 'obsidianPort',
        '#ss_context_ai_messages': 'contextAiMessages',
    };
    for (const [selector, key] of Object.entries(numFields)) {
        $(selector).on('input', function () {
            const parsed = parseInt($(this).val(), 10);
            if (isNaN(parsed)) {
                getSettings()[key] = defaultSettings[key];
                $(this).val(defaultSettings[key]);
            } else {
                getSettings()[key] = parsed;
            }
            saveSettingsDebounced();
        });
    }

    // Float input: confidence threshold
    $('#ss_confidence_threshold').on('input', function () {
        const parsed = parseFloat($(this).val());
        if (isNaN(parsed)) {
            getSettings().autoApplyThreshold = 0.7;
            $(this).val(0.7);
        } else {
            getSettings().autoApplyThreshold = Math.max(0, Math.min(1, parsed));
        }
        saveSettingsDebounced();
    });

    // Feature 17: Run validation after any number input change
    for (const selector of Object.keys(numFields)) {
        $(selector).on('input', validateSettingsUI);
    }
    $('#ss_proxy_url').on('input', validateSettingsUI);
    $('#ss_model').on('input', validateSettingsUI);

    // Test buttons
    $('#ss_test_proxy').on('click', testAiConnection);
    $('#ss_test_obsidian').on('click', testObsidianConnection);
    $('#ss_seed_patterns').on('click', seedObsidianPatterns);

    // Analyze button
    $('#ss_analyze_btn').on('click', async function () {
        const btn = $(this);
        if (btn.hasClass('disabled')) return;
        if (processingMessageId !== null) {
            toastr.info('A refinement is in progress — please wait', 'SloppySeconds');
            return;
        }

        const settings = getSettings();
        if (!settings.enabled) {
            toastr.warning('SloppySeconds is disabled', 'SloppySeconds');
            return;
        }

        const target = findLastAiMessage();
        if (!target) {
            toastr.info('No AI message found', 'SloppySeconds');
            return;
        }

        btn.addClass('disabled');
        btn.find('span').text('Analyzing...');
        btn.find('i').removeClass('fa-magnifying-glass').addClass('fa-spinner fa-spin');

        try {
            if (settings.obsidianEnabled && !obsidianPatternsLoaded) {
                await loadObsidianPatterns();
            }

            const result = await analyzeText(target.message.mes, target.index);

            if (!result.findings || result.findings.length === 0) {
                toastr.success('No slop detected — message is clean!', 'SloppySeconds');
                return;
            }

            const title = `${result.findings.length} finding${result.findings.length !== 1 ? 's' : ''} (detect only, not applied)`;
            const html = buildFindingsHtml(title, result.findings, result.summary, { newPatterns: result.newPatterns });
            callGenericPopup(html, POPUP_TYPE.TEXT, '', { wide: true });
        } catch (err) {
            toastr.warning(`Detection failed: ${err.message}`, 'SloppySeconds');
        } finally {
            btn.removeClass('disabled');
            btn.find('span').text('Analyze Last Message');
            btn.find('i').removeClass('fa-spinner fa-spin').addClass('fa-magnifying-glass');
        }
    });
}

function updateConnectionVisibility() {
    const settings = getSettings();
    const isProfile = settings.connectionMode === 'profile';
    $('#ss_profile_row').toggle(isProfile);
    $('#ss_proxy_row').toggle(!isProfile);
}

function populateProfileDropdown() {
    const select = document.getElementById('ss_profile_select');
    if (!select) return;

    const settings = getSettings();
    const currentId = settings.profileId;

    select.innerHTML = '<option value="">— Select a profile —</option>';
    try {
        const profiles = ConnectionManagerRequestService.getSupportedProfiles();
        for (const p of profiles) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.api}${p.model ? ' / ' + p.model : ''})`;
            if (p.id === currentId) opt.selected = true;
            select.appendChild(opt);
        }
    } catch {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Connection Manager not available';
        opt.disabled = true;
        select.appendChild(opt);
    }
}

async function testAiConnection() {
    const settings = getSettings();
    const statusEl = $('#ss_proxy_status');
    statusEl.text('Testing...').css('color', '');

    try {
        if (settings.connectionMode === 'profile') {
            // Test via Connection Manager profile
            await callViaProfile(
                'You are a test endpoint. Respond with exactly: {"status":"ok"}',
                'Test connection. Respond with exactly: {"status":"ok"}',
                32,
                10000,
            );
            statusEl.text('Profile connected!').css('color', '#4caf50');
        } else {
            // Test via CORS proxy bridge
            await callViaCorsBridge(
                settings.proxyUrl,
                settings.model,
                'Test. Respond ok.',
                'Test connection.',
                32,
                0,
                10000,
            );
            statusEl.text('Connected!').css('color', '#4caf50');
        }
    } catch (err) {
        statusEl.text(`Failed: ${err.message}`).css('color', '#f44336');
    }
}

async function testObsidianConnection() {
    const settings = getSettings();
    const statusEl = $('#ss_obsidian_status');
    statusEl.text('Testing...').css('color', '');

    try {
        const result = await obsidianFetch({
            port: settings.obsidianPort,
            apiKey: settings.obsidianApiKey,
            path: '/',
            timeout: 10000,
        });

        if (result.status === 200) {
            let parsed;
            try { parsed = JSON.parse(result.data); } catch { parsed = {}; }
            statusEl.text(parsed.authenticated ? 'Connected & authenticated!' : 'Connected (not authenticated)').css('color', '#4caf50');
        } else {
            statusEl.text(`Failed: HTTP ${result.status}`).css('color', '#f44336');
        }
    } catch (err) {
        statusEl.text(`Error: ${err.message}`).css('color', '#f44336');
    }
}

/**
 * Feature 17: Validate settings and show inline warnings.
 */
function validateSettingsUI() {
    const s = getSettings();
    // Remove all existing warnings
    $('.ss_validation_warning').remove();

    const warn = (selector, msg) => {
        $(selector).after(`<div class="ss_validation_warning" style="color: #f44336; font-size: 0.8em; margin-top: 2px;">${msg}</div>`);
    };

    // Model must not be empty (proxy mode only)
    if (s.connectionMode === 'proxy' && !s.model?.trim()) {
        warn('#ss_model', 'Model name is required for proxy mode');
    }

    // Proxy URL must look like a URL
    if (s.connectionMode === 'proxy' && s.proxyUrl) {
        try {
            new URL(s.proxyUrl);
        } catch {
            warn('#ss_proxy_url', 'Invalid URL format');
        }
    }

    // Thinking budget vs maxTokens
    if (s.thinkingBudget > 0 && s.maxTokens <= s.thinkingBudget) {
        warn('#ss_thinking_budget', `Thinking budget (${s.thinkingBudget}) >= max tokens (${s.maxTokens}) — will auto-adjust to ${s.thinkingBudget + 4096}`);
    }

    // Port range
    if (s.obsidianEnabled && (s.obsidianPort < 1 || s.obsidianPort > 65535)) {
        warn('#ss_obsidian_port', 'Port must be 1-65535');
    }

    // Timeout range
    if (s.timeout < 5000) {
        warn('#ss_timeout', 'Timeout under 5s may cause frequent failures');
    }
}
