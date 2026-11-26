import json
import os
import sys
import time
import urllib.request
from playwright.sync_api import sync_playwright


def find_chrome():
    for candidate in (
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ):
        if os.path.exists(candidate):
            return candidate
    return None


def http_json(url, method="GET", body=None, headers=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None and "Content-Type" not in req.headers:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=15) as resp:
        raw = resp.read().decode("utf-8")
        return resp.status, json.loads(raw) if raw else None


def main():
    raw_cfg = os.environ.get("LOOP_EVAL_CONFIG", "")
    if not raw_cfg:
        raise RuntimeError("Missing LOOP_EVAL_CONFIG environment variable.")
    cfg = json.loads(raw_cfg)
    base = cfg["baseUrl"]
    conn_id = cfg["connId"]
    shots_dir = cfg.get("screenshotsDir") or ""

    report = {
        "seedStatus": cfg.get("seedStatus"),
        "consoleErrors": [],
        "consoleOther": [],
        "pageErrors": [],
        "httpErrors": [],
        "scenarios": {},
        "assertions": [],
    }

    def check(name, passed, detail=""):
        report["assertions"].append({"name": name, "passed": bool(passed), "detail": detail})

    def stage(label):
        print(f"[eval:browser] {label}", flush=True)

    def snap(page, filename):
        if shots_dir:
            os.makedirs(shots_dir, exist_ok=True)
            page.screenshot(path=os.path.join(shots_dir, filename))

    chrome_path = find_chrome()
    with sync_playwright() as p:
        launch_kwargs = {"headless": True}
        if chrome_path:
            launch_kwargs["executable_path"] = chrome_path
        browser = p.chromium.launch(**launch_kwargs)
        context = browser.new_context(viewport={"width": 1440, "height": 900})
        page = context.new_page()

        def on_console(m):
            entry = {"type": m.type, "text": m.text}
            if m.type == "error":
                report["consoleErrors"].append(entry)
            else:
                report["consoleOther"].append(entry)

        page.on("console", on_console)
        page.on("pageerror", lambda e: report["pageErrors"].append(str(e)))
        page.on(
            "response",
            lambda r: report["httpErrors"].append({"url": r.url, "status": r.status})
            if r.status >= 400
            else None,
        )

        # Scenario 1: Unauthenticated visit to /inspector shows clean sign-in banner (no crash)
        stage("1: unauth /inspector")
        page.goto(base + "/inspector", wait_until="domcontentloaded")
        time.sleep(0.5)
        unauth_banner = page.locator("#insp-banner").inner_text() if not page.locator("#insp-banner").is_hidden() else ""
        report["scenarios"]["unauth_inspector"] = {"banner": unauth_banner}
        check("unauth_shows_signin_banner", "Sign in" in unauth_banner, unauth_banner)
        # Clear expected 401 from unauth probe so later checks track unexpected HTTP/console errors
        unauth_401s = [e for e in report["httpErrors"] if e["status"] == 401]
        report["httpErrors"] = [e for e in report["httpErrors"] if e["status"] != 401]
        report["consoleErrors"] = [e for e in report["consoleErrors"] if "401" not in e["text"]]
        check("unauth_api_blocked_401", len(unauth_401s) >= 1, f"{len(unauth_401s)} blocked")

        # Scenario 2: Owner signs in and checks Settings -> General -> MCP Inspector link
        stage("2: login & settings link")
        page.goto(base + "/", wait_until="domcontentloaded")
        login_res = page.evaluate(
            """async (pw) => {
              const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pw }),
              });
              return { status: res.status, ok: res.ok };
            }""",
            cfg["password"],
        )
        check("owner_login_ok", login_res["ok"], str(login_res))
        page.goto(base + "/#settings", wait_until="domcontentloaded")
        page.reload(wait_until="domcontentloaded")
        time.sleep(0.8)
        has_settings_link = page.locator('a[href="/inspector"]').count() >= 1
        report["scenarios"]["dashboard_settings_link"] = {"present": has_settings_link}
        check("settings_has_inspector_link", has_settings_link)

        # Scenario 3: Open /inspector, verify auto-initialize, live SSE, tools, widgets, resources, prompts
        stage("3: boot /inspector")
        page.goto(base + "/inspector", wait_until="domcontentloaded")
        page.wait_for_function(
            "() => document.getElementById('insp-status-pill')?.textContent?.trim() === 'Ready'",
            timeout=10000,
        )
        time.sleep(0.35)
        boot = page.evaluate(
            """() => ({
              endpoint: document.getElementById('insp-endpoint')?.textContent,
              tools: [...document.querySelectorAll('#insp-side-list .insp-item-name')].map(n => n.textContent),
              agents: [...document.getElementById('insp-agent').options].map(o => ({ v: o.value, t: o.textContent })),
              bannerHidden: document.getElementById('insp-banner').hidden,
            })"""
        )
        report["scenarios"]["boot"] = boot
        check("boot_ready_with_loop_tools", "loop__search" in boot["tools"] and "loop__save" in boot["tools"] and "loop__show" in boot["tools"], str(boot["tools"]))
        check("upstream_visual_tool_exposed_directly", f"{conn_id}__revenue_chart" in boot["tools"], str(boot["tools"]))

        def guest_frame():
            for f in page.frames:
                if f != page.main_frame and f.parent_frame and f.parent_frame != page.main_frame:
                    return f
            return None

        def guest_loc():
            return page.frame_locator("#insp-sandbox-frame").frame_locator("#guest")

        def wait_widget(timeout_ms=5000):
            try:
                page.wait_for_function(
                    "() => document.getElementById('insp-widget-state')?.textContent?.trim() === 'Connected'",
                    timeout=timeout_ms,
                )
                return True
            except Exception:
                return False

        def snapshot_guest():
            gf = guest_frame()
            if not gf:
                return {"error": "Guest frame missing"}
            return gf.evaluate(
                """() => ({
                  origin: window.origin,
                  theme: document.documentElement.getAttribute('data-theme'),
                  text: document.body.innerText,
                  items: document.querySelectorAll('.w-item').length,
                  cards: document.querySelectorAll('.w-card').length,
                  metrics: document.querySelectorAll('.w-metric').length,
                  checkItems: document.querySelectorAll('.w-check-item').length,
                  tableRows: document.querySelectorAll('tbody tr').length,
                  images: [...document.querySelectorAll('img.w-img')].map(i => ({ complete: i.complete, naturalWidth: i.naturalWidth, srcPrefix: i.src.slice(0, 30) })),
                  linkButtons: [...document.querySelectorAll('button.w-link-card')].map(b => b.innerText.trim()),
                  buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()),
                  pills: [...document.querySelectorAll('.w-pill')].map(p => p.textContent.trim()),
                  hasDrawer: Boolean(document.querySelector('.w-drawer')),
                  drawerText: document.querySelector('.w-drawer')?.innerText || '',
                  xssPwned: Boolean(window.__XSS_PWNED__),
                })"""
            )

        def run_tool(tool_name, args_obj):
            page.click('[data-side-tab="tools"]')
            page.locator("#insp-side-list .insp-item", has_text=tool_name).first.click()
            page.fill("#insp-json-input", json.dumps(args_obj, indent=2))
            page.click("#insp-run-btn")
            page.wait_for_function("() => !document.getElementById('insp-run-btn').disabled", timeout=10000)
            wait_widget()
            time.sleep(0.35)
            return {
                "status": page.locator("#insp-status-pill").text_content(),
                "widgetUri": page.locator("#insp-widget-uri").text_content(),
                "widgetState": page.locator("#insp-widget-state").text_content(),
                "frameHeight": page.evaluate("() => document.getElementById('insp-sandbox-frame').style.height"),
                "altBtnVisible": not page.locator("#insp-widget-alt").is_hidden(),
                "cspBtnVisible": not page.locator("#insp-widget-csp").is_hidden(),
                "cspBtnText": page.locator("#insp-widget-csp").text_content(),
                "responseText": page.locator("#insp-response-pre").text_content()[:1400],
                "guest": snapshot_guest(),
            }

        # Scenario 4: loop__search across all types + filter chips + inline Inspect + Enter-key live search
        s_all = run_tool("loop__search", {"type": "all"})
        snap(page, "eval2-search-all.png")
        check("search_all_connected", s_all["widgetState"] == "Connected")
        check("search_all_summary_chips", "1 connections" in s_all["guest"]["text"] and "2 vault" in s_all["guest"]["text"])

        # Click filter chip "Connections (1)" inside widget
        guest_loc().locator("button.w-pill", has_text="Connections").first.click()
        time.sleep(0.25)
        after_filter = snapshot_guest()
        check("search_filter_pill_works", after_filter["items"] == 1 and "Acme Analytics" in after_filter["text"])
        guest_loc().locator("button.w-pill", has_text="All").first.click()
        time.sleep(0.2)

        # Click Inspect inside widget -> drawer opens -> Close closes it
        guest_loc().locator("button", has_text="Inspect").first.click()
        time.sleep(0.5)
        after_inspect = snapshot_guest()
        check("search_inline_inspect_drawer", after_inspect["hasDrawer"] and "Acme Analytics" in after_inspect["drawerText"])
        guest_loc().locator("button", has_text="Close").first.click()
        time.sleep(0.2)
        check("search_drawer_close", not snapshot_guest()["hasDrawer"])

        # Press Enter in widget search box (keyboard workflow, no <form>)
        q_inp = guest_loc().locator("input[type='search']")
        q_inp.fill("echo")
        q_inp.press("Enter")
        time.sleep(0.55)
        after_enter = snapshot_guest()
        check("search_enter_key_live_search", "acme_analytics__echo" in after_enter["text"])

        # Search memory, tasks, saved, vault
        s_mem = run_tool("loop__search", {"type": "memory"})
        check("search_memory_shows_seeded", "Hetzner Nuremberg" in s_mem["guest"]["text"] or "deploy-region" in s_mem["guest"]["text"], s_mem["guest"]["text"][:200])

        s_tasks = run_tool("loop__search", {"type": "tasks"})
        check("search_tasks_shows_seeded", "Ship MCP Apps v2" in s_tasks["guest"]["text"], s_tasks["guest"]["text"][:200])

        s_saved = run_tool("loop__search", {"type": "saved"})
        check("search_saved_shows_seeded", "Q4 Launch Readiness Card" in s_saved["guest"]["text"], s_saved["guest"]["text"][:200])

        s_vault = run_tool("loop__search", {"type": "vault"})
        check(
            "search_vault_metadata_no_leak",
            "ACME_SECRET" in s_vault["guest"]["text"]
            and "CORP_CARD" in s_vault["guest"]["text"]
            and cfg["secretVal"] not in s_vault["guest"]["text"]
            and cfg["cardVal"] not in s_vault["guest"]["text"],
        )
        report["scenarios"]["search"] = {
            "allItems": s_all["guest"]["items"],
            "memItems": s_mem["guest"]["items"],
            "taskItems": s_tasks["guest"]["items"],
            "savedItems": s_saved["guest"]["items"],
            "vaultItems": s_vault["guest"]["items"],
            "vaultHeight": s_vault["frameHeight"],
        }

        # Scenario 5: loop__inspect on Full @json-render/core Saved Artifact Card + Tool interactive Run + Invalid JSON handling
        check("saved_card_rejects_javascript_link", bool(cfg.get("evilSavedRejected")))
        check("saved_card_seeded", bool(cfg.get("savedCardId")), str(cfg.get("savedCardId")))
        if cfg.get("savedCardId"):
            insp_card = run_tool("loop__inspect", {"type": "saved", "id": cfg["savedCardId"]})
            snap(page, "eval2-json-render-card.png")
            g = insp_card["guest"]
            check("json_render_state_and_metrics", g["metrics"] == 2 and "Production (Hetzner)" in g["text"], g["text"][:300])
            check("json_render_checklist_and_table", g["checkItems"] == 2 and g["tableRows"] == 2)
            check("json_render_safe_link_renders", len(g["linkButtons"]) == 1 and "Open Loop Docs" in g["linkButtons"][0], str(g["linkButtons"]))
            # Verify Raw JSON is collapsed by default when a visual card rendered
            raw_json_open = guest_frame().evaluate(
                "() => [...document.querySelectorAll('details')].some(d => d.textContent.includes('Raw JSON') && d.open)"
            )
            check("saved_card_raw_json_collapsed_by_default", not raw_json_open)
            # Verify two-way JSON -> Parameters form sync updated the 'type' dropdown to 'saved'!
            synced_type = page.locator('#insp-schema-form [data-param-key="type"]').input_value()
            check("json_to_form_two_way_sync", synced_type == "saved", synced_type)
            report["scenarios"]["inspect_saved_json_render"] = {
                "metrics": g["metrics"],
                "checkItems": g["checkItems"],
                "tableRows": g["tableRows"],
                "linkButtons": g["linkButtons"],
                "height": insp_card["frameHeight"],
            }

        # Verify Copy RPC, Copy cURL, Width switcher (360px / 480px / full), and Cmd/Ctrl+Enter keyboard Run!
        page.click("#insp-copy-rpc")
        time.sleep(0.15)
        check("copy_rpc_button_feedback", "Copied" in page.locator("#insp-copy-rpc").text_content())
        page.click("#insp-copy-curl")
        time.sleep(0.15)
        check("copy_curl_button_feedback", "Copied" in page.locator("#insp-copy-curl").text_content())
        page.click('[data-widget-width="360"]')
        time.sleep(0.2)
        stage_width_360 = page.evaluate("() => Math.round(document.getElementById('insp-widget-stage').getBoundingClientRect().width)")
        check("widget_width_preset_360px", 340 <= stage_width_360 <= 370, str(stage_width_360))
        page.click('[data-widget-width="full"]')
        time.sleep(0.15)

        # Verify Ctrl+Enter keyboard run inside JSON editor
        page.click('[data-side-tab="tools"]')
        page.locator("#insp-side-list .insp-item", has_text="loop__search").first.click()
        page.fill("#insp-json-input", json.dumps({"type": "vault"}, indent=2))
        page.locator("#insp-json-input").press("Control+Enter")
        page.wait_for_function("() => !document.getElementById('insp-run-btn').disabled", timeout=10000)
        wait_widget()
        time.sleep(0.3)
        check("keyboard_ctrl_enter_runs_tool", "ACME_SECRET" in snapshot_guest()["text"])

        insp_tool = run_tool("loop__inspect", {"type": "tool", "id": f"{conn_id}__echo"})
        guest_loc().locator("summary", has_text="Run this tool").click()
        # First test invalid JSON inside widget -> graceful error message
        guest_loc().locator("textarea.w-textarea").fill("{not-json")
        guest_loc().locator("button", has_text="Run via loop__run").click()
        time.sleep(0.25)
        bad_json_txt = snapshot_guest()["text"]
        check("inspect_widget_invalid_json_handled", "Invalid JSON arguments" in bad_json_txt)
        # Now valid JSON -> live execution
        guest_loc().locator("textarea.w-textarea").fill('{"message":"verified-in-eval"}')
        guest_loc().locator("button", has_text="Run via loop__run").click()
        time.sleep(0.55)
        good_run_txt = snapshot_guest()["text"]
        check("inspect_widget_live_run_ok", "verified-in-eval" in good_run_txt)

        # Scenario 6: loop__run — Error, Image (PNG ok, SVG blocked), Mixed Batch, Full Live Approval->Approve->Check Status, Guard
        r_err = run_tool("loop__run", {"tool": f"{conn_id}__fail_boom", "arguments": {}})
        check("run_error_renders_err_pill", r_err["status"] == "Error" and "Error" in r_err["guest"]["pills"] and "rate limit" in r_err["guest"]["text"])

        r_img = run_tool("loop__run", {"tool": f"{conn_id}__render_badge_image", "arguments": {}})
        imgs = r_img["guest"]["images"]
        check("run_image_png_rendered_svg_blocked", len(imgs) == 1 and imgs[0]["srcPrefix"].startswith("data:image/png;base64,"), str(imgs))

        r_batch = run_tool(
            "loop__run",
            {
                "calls": [
                    {"tool": f"{conn_id}__echo", "arguments": {"message": "ok-item"}},
                    {"tool": f"{conn_id}__fail_boom", "arguments": {}},
                ]
            },
        )
        check("run_mixed_batch_ok_and_error", r_batch["guest"]["cards"] == 2 and "OK" in r_batch["guest"]["pills"] and "Error" in r_batch["guest"]["pills"])

        # Live End-to-End Approval Flow: Pending -> Owner approves via API -> Click "Check status" inside widget -> Executes!
        r_ask = run_tool("loop__run", {"tool": f"{conn_id}__delete_record", "arguments": {"recordId": "rec_99"}})
        check("approval_ask_pending_card", "Pending" in r_ask["guest"]["pills"] and "Check status" in r_ask["guest"]["buttons"])
        # Extract approvalId from response and approve as signed-in owner
        apr_id = None
        try:
            resp_obj = json.loads(page.locator("#insp-response-pre").text_content())
            inner = json.loads(resp_obj["result"]["content"][0]["text"])
            apr_id = inner.get("approvalId")
        except Exception:
            pass
        check("approval_id_found", bool(apr_id), str(apr_id))
        if apr_id:
            approved = page.evaluate(
                """async (id) => {
                  const res = await fetch('/api/approvals/' + encodeURIComponent(id) + '/approve', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                  });
                  return { status: res.status, ok: res.ok };
                }""",
                apr_id,
            )
            check("owner_approved_via_api", approved["ok"], str(approved))
            guest_loc().locator("button", has_text="Check status").click()
            time.sleep(0.7)
            after_approve = snapshot_guest()
            check("widget_check_status_completed_call", "rec_99" in after_approve["text"] and "OK" in after_approve["pills"], after_approve["text"][:250])

        # Guarded Vault tool
        r_guard = run_tool("loop__run", {"tool": f"{conn_id}__echo", "arguments": {"message": "{{vault:CORP_CARD}}"}})
        check(
            "approval_guard_enforced_no_bypass",
            "Guard" in r_guard["guest"]["pills"]
            and "Loop password" in r_guard["guest"]["text"]
            and "Check status" not in r_guard["guest"]["buttons"],
        )

        # Interactive MCP elicitation/create simulator: enable Elicit, run always_ask tool -> dialog opens -> click Accept -> tool executes!
        page.check("#insp-elicit-cap")
        page.click('[data-side-tab="tools"]')
        page.locator("#insp-side-list .insp-item", has_text="loop__run").first.click()
        page.fill(
            "#insp-json-input",
            json.dumps({"tool": f"{conn_id}__delete_record", "arguments": {"recordId": "rec_elicit_7"}}, indent=2),
        )
        page.click("#insp-run-btn")
        page.wait_for_function("() => document.getElementById('insp-elicit-dialog')?.open === true", timeout=8000)
        elicit_mode_txt = page.locator("#insp-elicit-mode").text_content()
        check(
            "elicit_form_hides_guard_and_url_box",
            page.locator("#insp-elicit-guard").is_hidden() and page.locator("#insp-elicit-url-box").is_hidden(),
        )
        snap(page, "eval3-elicit-dialog.png")
        time.sleep(0.85)
        page.click("#insp-elicit-accept")
        page.wait_for_function("() => !document.getElementById('insp-run-btn').disabled", timeout=10000)
        wait_widget()
        time.sleep(0.35)
        elicit_result_txt = snapshot_guest()["text"]
        page.uncheck("#insp-elicit-cap")
        check(
            "elicit_simulator_form_approval_completes_call",
            "form" in elicit_mode_txt and "rec_elicit_7" in elicit_result_txt and "OK" in snapshot_guest()["pills"],
            elicit_result_txt[:220],
        )

        # Scenario 7: Upstream MCP App via loop__run + Switch view + Opt-in CSP toggle
        r_up = run_tool("loop__run", {"tool": f"{conn_id}__revenue_chart", "arguments": {"quarter": "Q4"}})
        snap(page, "eval2-upstream-csp-toggle.png")
        check("upstream_auto_selected_via_loop_run", "Upstream Chart Loaded" in r_up["guest"]["text"] and r_up["altBtnVisible"])
        check("upstream_csp_optin_button_sanitized", r_up["cspBtnVisible"] and r_up["cspBtnText"] == "Allow CSP (2)", str(r_up["cspBtnText"]))

        # Toggle opt-in CSP ON -> verify sandbox iframe src includes public HTTPS origins and NEVER localhost/127.0.0.1
        page.click("#insp-widget-csp")
        wait_widget()
        time.sleep(0.3)
        sandbox_src_on = page.evaluate("() => document.getElementById('insp-sandbox-frame').getAttribute('src')")
        csp_btn_on = page.locator("#insp-widget-csp").text_content()
        check(
            "csp_optin_enabled_cleanly",
            "https%3A%2F%2Fapi.example.com" in sandbox_src_on
            and "127.0.0.1" not in sandbox_src_on
            and "localhost" not in sandbox_src_on
            and csp_btn_on == "CSP allowed (2)",
            sandbox_src_on,
        )
        # Toggle opt-in CSP back OFF -> strict default restored
        page.click("#insp-widget-csp")
        wait_widget()
        time.sleep(0.25)
        sandbox_src_off = page.evaluate("() => document.getElementById('insp-sandbox-frame').getAttribute('src')")
        check("csp_optin_reverts_to_strict", sandbox_src_off == "/inspector/sandbox", sandbox_src_off)

        # Click "Loop view" alternate toggle -> switches to ui://loop/run, then back
        page.click("#insp-widget-alt")
        wait_widget()
        time.sleep(0.3)
        alt_uri = page.locator("#insp-widget-uri").text_content()
        check("alt_widget_toggle_switches_to_loop_run", alt_uri == "ui://loop/run", alt_uri)

        # Scenario 8: Partial-argument Stream Simulator
        page.check("#insp-stream-args")
        r_stream = run_tool("loop__search", {"type": "tools", "query": "revenue"})
        page.uncheck("#insp-stream-args")
        page.click('[data-out-tab="protocol"]')
        time.sleep(0.2)
        wire_txt = page.locator("#insp-protocol-list").inner_text()
        check("stream_simulator_sent_partial_frames", "ui/notifications/tool-input-partial" in wire_txt and "acme_analytics__revenue_chart" in r_stream["guest"]["text"])
        check("wire_log_summarizes_html_bundles", "[MCP App HTML bundle," in wire_txt)

        # Scenario 9: Live SSE Traffic Push from an External MCP Agent (zero manual Refresh!)
        page.click('[data-side-tab="traffic"]')
        time.sleep(0.4)
        traffic_head_text = page.locator("#insp-side-list").inner_text()
        check("traffic_shows_live_sse_pill", "Live SSE" in traffic_head_text, traffic_head_text[:120])
        before_count = page.locator("#insp-side-list .insp-item").count()
        # Fire an external /mcp request directly from Python urllib (simulating Claude Desktop / Cursor)
        http_json(
            base + "/mcp",
            method="POST",
            body={
                "jsonrpc": "2.0",
                "id": 999,
                "method": "tools/call",
                "params": {"name": "loop__search", "arguments": {"type": "tools", "query": "external-sse-sentinel"}},
            },
            headers={"Authorization": f"Bearer {cfg['ownerToken']}", "Accept": "application/json"},
        )
        time.sleep(0.6)
        after_count = page.locator("#insp-side-list .insp-item").count()
        after_traffic_text = page.locator("#insp-side-list").inner_text()
        check("live_sse_pushed_external_mcp_call", after_count > before_count and "Claude Desktop" in after_traffic_text, f"{before_count} -> {after_count}")
        snap(page, "eval2-live-sse-traffic.png")

        # Click newest traffic item to replay it
        page.locator("#insp-side-list .insp-item").first.click()
        time.sleep(0.4)
        replayed_json = page.locator("#insp-json-input").input_value()
        check("traffic_replay_populates_request_builder", "external-sse-sentinel" in replayed_json)

        # Scenario 10: loop__save (Organize diff + Vault capture)
        r_org = run_tool(
            "loop__save",
            {
                "type": "category",
                "dryRun": True,
                "data": {
                    "createCategories": [{"label": "Analytics", "description": "Metrics"}],
                    "assignConnections": {conn_id: "Analytics"},
                },
            },
        )
        check("save_organize_diff_table", r_org["guest"]["tableRows"] == 2 and "Analytics" in r_org["guest"]["text"])

        r_cap = run_tool("loop__save", {"type": "api_key", "action": "capture", "id": "Stripe"})
        check("save_vault_capture_single_clean_card", r_cap["guest"]["cards"] == 1 and "Open in Loop" in r_cap["guest"]["buttons"])

        r_save_card = run_tool(
            "loop__save",
            {
                "type": "saved",
                "data": {
                    "kind": "artifact",
                    "title": "Inline Save Card",
                    "ui": {
                        "root": "c1",
                        "elements": {
                            "c1": {
                                "type": "Card",
                                "props": {"title": "Weekly Metrics", "tone": "ok"},
                                "children": ["m1"],
                            },
                            "m1": {
                                "type": "MetricGrid",
                                "props": {
                                    "items": [
                                        {"label": "Uptime", "value": "99.98%", "tone": "ok"},
                                    ]
                                },
                            },
                        },
                    },
                },
            },
        )
        check(
            "save_json_render_card_renders_directly",
            r_save_card["guest"]["metrics"] == 1
            and "Weekly Metrics" in r_save_card["guest"]["text"]
            and "99.98%" in r_save_card["guest"]["text"]
            and "MCP App" not in r_save_card["guest"]["text"],
            r_save_card["guest"]["text"][:200],
        )

        # Scenario 10b: loop__show renders rich @json-render/core visual card (Metrics, Progress, BarChart, Steps, ItemList, Tabs, primary Link CTA, Image)
        r_show = run_tool(
            "loop__show",
            {
                "title": "Doop Design Milestone",
                "ui": {
                    "root": "c1",
                    "elements": {
                        "c1": {
                            "type": "Card",
                            "props": {"kicker": "Doop Design", "subtitle": "5 screens updated", "tone": "ok"},
                            "children": ["m1", "p1", "tabs1", "cta1"],
                        },
                        "m1": {
                            "type": "MetricGrid",
                            "props": {"items": [{"label": "Screens", "value": "5", "tone": "ok"}]},
                        },
                        "p1": {
                            "type": "Progress",
                            "props": {"label": "Review completion", "value": 80, "max": 100, "tone": "ok"},
                        },
                        "tabs1": {
                            "type": "Tabs",
                            "props": {
                                "items": [
                                    {"label": "Overview", "elementId": "ov1"},
                                    {"label": "Apps", "elementId": "apps1"},
                                ]
                            },
                            "children": ["ov1", "apps1"],
                        },
                        "ov1": {
                            "type": "Stack",
                            "props": {"direction": "column"},
                            "children": ["b1", "s1", "img1"],
                        },
                        "b1": {
                            "type": "BarChart",
                            "props": {
                                "title": "Screens by flow",
                                "items": [
                                    {"label": "Accounts", "value": 3, "displayValue": "3", "tone": "ok"},
                                    {"label": "Access", "value": 2, "displayValue": "2", "tone": "info"},
                                ],
                            },
                        },
                        "s1": {
                            "type": "Steps",
                            "props": {
                                "items": [
                                    {"label": "Build components", "status": "done"},
                                    {"label": "Final review", "status": "active"},
                                ]
                            },
                        },
                        "img1": {
                            "type": "Image",
                            "props": {
                                "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                                "alt": "Preview pixel",
                            },
                        },
                        "apps1": {
                            "type": "ItemList",
                            "props": {
                                "items": [
                                    {
                                        "title": "Google Drive",
                                        "subtitle": "Connect account",
                                        "badge": "Sign in",
                                        "badgeTone": "warn",
                                        "url": "https://useloop.sh/connect",
                                        "actionLabel": "Sign in",
                                        "actionVariant": "primary",
                                    }
                                ]
                            },
                        },
                        "cta1": {
                            "type": "Link",
                            "props": {
                                "label": "Open Canvas",
                                "url": "https://useloop.sh/",
                                "variant": "primary",
                            },
                        },
                    },
                },
            },
        )
        check(
            "loop_show_renders_visual_card_and_image",
            r_show["widgetUri"] == "ui://loop/show"
            and r_show["guest"]["metrics"] == 1
            and len(r_show["guest"]["images"]) == 1
            and "Doop Design Milestone" in r_show["guest"]["text"]
            and "80%" in r_show["guest"]["text"]
            and "Open Canvas" in r_show["guest"]["text"]
            and "Google Drive" not in r_show["guest"]["text"]
            and "MCP App" not in r_show["guest"]["text"],
            r_show["guest"]["text"][:240],
        )
        guest_loc().locator("button.w-tab-btn", has_text="Apps").first.click()
        time.sleep(0.15)
        after_tab = snapshot_guest()
        check(
            "loop_show_tabs_switch_cleanly",
            "Google Drive" in after_tab["text"] and "Screens by flow" not in after_tab["text"],
            after_tab["text"][:200],
        )

        # Scenario 11: Resources tab (plain text) & Prompts tab (schema form)
        page.click('[data-side-tab="resources"]')
        time.sleep(0.3)
        page.locator("#insp-side-list .insp-item", has_text="Ops Handbook").first.click()
        page.click("#insp-run-btn")
        page.wait_for_function("() => !document.getElementById('insp-run-btn').disabled", timeout=10000)
        time.sleep(0.3)
        check("plain_resource_read_works", "Loop Live Eval Ops Guide" in page.locator("#insp-response-pre").text_content())

        page.click('[data-side-tab="prompts"]')
        time.sleep(0.3)
        page.locator("#insp-side-list .insp-item", has_text="weekly_digest").first.click()
        page.locator("#insp-schema-form input").first.fill("Platform")
        page.click("#insp-run-btn")
        page.wait_for_function("() => !document.getElementById('insp-run-btn').disabled", timeout=10000)
        time.sleep(0.3)
        check("prompt_get_via_schema_form_works", "Weekly digest for Platform" in page.locator("#insp-response-pre").text_content())

        # Scenario 12: Non-UI capability toggle, Agent simulation, and Loop Paused state
        page.uncheck("#insp-ui-cap")
        page.wait_for_function("() => document.getElementById('insp-status-pill')?.textContent?.trim() === 'Ready'", timeout=10000)
        page.click('[data-side-tab="resources"]')
        time.sleep(0.3)
        no_ui_resources = page.locator("#insp-side-list").inner_text()
        check("ui_cap_off_hides_ui_resources", "ui://loop/" not in no_ui_resources)
        page.check("#insp-ui-cap")
        page.wait_for_function("() => document.getElementById('insp-status-pill')?.textContent?.trim() === 'Ready'", timeout=10000)

        page.select_option("#insp-agent", cfg["restrictedAgentId"])
        page.wait_for_function("() => document.getElementById('insp-status-pill')?.textContent?.trim() === 'Ready'", timeout=10000)
        r_denied = run_tool("loop__search", {"type": "memory"})
        check("restricted_agent_denied_memory", r_denied["status"] == "Error")
        page.select_option("#insp-agent", "")
        page.wait_for_function("() => document.getElementById('insp-status-pill')?.textContent?.trim() === 'Ready'", timeout=10000)

        # Scenario 13: XSS probe + Sandbox security probe + Dark theme + Mobile responsive
        r_xss = run_tool("loop__run", {"tool": f"{conn_id}__xss_probe", "arguments": {}})
        check("xss_inert_in_guest_and_host", not r_xss["guest"]["xssPwned"] and not page.evaluate("() => Boolean(window.__XSS_PWNED__)"))

        gf = guest_frame()
        sec = gf.evaluate(
            """async (baseUrl) => {
              const out = { origin: window.origin };
              try { void window.parent.document; out.parentBlocked = false; } catch (e) { out.parentBlocked = true; }
              try { await fetch(baseUrl + '/api/vault'); out.netBlocked = false; } catch (e) { out.netBlocked = true; }
              return out;
            }""",
            base,
        )
        check("sandbox_opaque_origin_and_isolation", sec["origin"] == "null" and sec["parentBlocked"] and sec["netBlocked"], str(sec))

        page.click("#insp-theme-btn")
        time.sleep(0.25)
        check("dark_theme_propagates_to_widget", snapshot_guest()["theme"] == "dark")

        page.click('[data-side-tab="checks"]')
        time.sleep(0.4)
        checks_text = page.locator("#insp-side-list").inner_text()
        check("audit_all_checks_pass", "11 pass" in checks_text and "fail" not in checks_text.lower(), checks_text[:200])

        page.set_viewport_size({"width": 390, "height": 844})
        time.sleep(0.25)
        overflow = page.evaluate("() => document.documentElement.scrollWidth > window.innerWidth + 2")
        check("mobile_zero_horizontal_overflow", not overflow)
        snap(page, "eval2-mobile.png")

        # Filter expected security-probe CSP error when scoring unexpected console errors
        unexpected_console = [
            c for c in report["consoleErrors"]
            if "api/vault" not in c["text"]
        ]
        check("zero_unexpected_console_errors", len(unexpected_console) == 0, str(unexpected_console))
        check("zero_page_errors", len(report["pageErrors"]) == 0, str(report["pageErrors"]))
        check("zero_http_errors", len(report["httpErrors"]) == 0, str(report["httpErrors"]))

        browser.close()

    passed = sum(1 for a in report["assertions"] if a["passed"])
    total = len(report["assertions"])
    failed = [a for a in report["assertions"] if not a["passed"]]
    report["summary"] = {"passed": passed, "failed": len(failed), "total": total}

    with open(cfg["reportPath"], "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print(f"EVAL_INSPECTOR_SUMMARY passed={passed}/{total} failed={len(failed)} report={cfg['reportPath']}")
    if failed:
        print("FAILED_ASSERTIONS:", json.dumps(failed, indent=2))
        sys.exit(1)


if __name__ == "__main__":
    main()
