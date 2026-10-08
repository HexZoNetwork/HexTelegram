

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"
)

type Call struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

func str(m map[string]any, k, def string) string {
	if v, ok := m[k].(string); ok && v != "" {
		return v
	}
	return def
}


var ipv4Dialer = &net.Dialer{Timeout: 10 * time.Second, Resolver: &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
	d := net.Dialer{Timeout: 10 * time.Second}
	return d.DialContext(ctx, "udp4", address)
}}}
func ipv4Transport() *http.Transport {
	return &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return ipv4Dialer.DialContext(ctx, "tcp4", addr)
		},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
	}
}
func httpClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: ipv4Transport(), CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return http.ErrUseLastResponse
		}
		return nil
	}}
}
func num(m map[string]any, k string, def float64) float64 {
	switch v := m[k].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	}
	return def
}


func toolShell(args map[string]any) string {
	cmd := str(args, "command", "")
	if cmd == "" {
		return "ERROR: empty command"
	}
	workDir := str(args, "workDir", "/")
	timeout := time.Duration(num(args, "timeoutSec", 30)) * time.Second
	maxChars := int(num(args, "maxChars", 8000))
	if timeout < time.Second {
		timeout = 30 * time.Second
	}
	if timeout > 5*time.Minute {
		timeout = 5 * time.Minute
	}
	c := exec.Command("bash", "-c", cmd)
	c.Dir = workDir
	var out, errb bytes.Buffer
	c.Stdout = &out
	c.Stderr = &errb
	done := make(chan error, 1)
	go func() { done <- c.Run() }()
	var err error
	select {
	case err = <-done:
	case <-time.After(timeout):
		_ = c.Process.Kill()
		return fmt.Sprintf("ERROR: timeout after %v\n%s", timeout, (out.String() + errb.String()))
	}
	s := out.String()
	if errb.Len() > 0 {
		s += "\n[stderr]\n" + errb.String()
	}
	if err != nil {
		s += fmt.Sprintf("\n[exit: %v]", err)
	}
	if len(s) > maxChars {
		s = s[:maxChars] + fmt.Sprintf("\n...[truncated, total %d chars]", len(out.String())+errb.Len())
	}
	if s == "" {
		return "(no output, exit ok)"
	}
	return s
}


func toolFileRead(args map[string]any) string {
	p := str(args, "path", "")
	if p == "" {
		return "ERROR: empty path"
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "ERROR: " + err.Error()
	}
	if len(b) > 8000 {
		return string(b[:8000]) + fmt.Sprintf("\n...[truncated, total %d bytes]", len(b))
	}
	return string(b)
}
func toolFileWrite(args map[string]any) string {
	p := str(args, "path", "")
	if p == "" {
		return "ERROR: empty path"
	}
	if dir := filepath.Dir(p); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	if err := os.WriteFile(p, []byte(str(args, "content", "")), 0o644); err != nil {
		return "ERROR: " + err.Error()
	}
	return "wrote " + p
}
func toolFileEdit(args map[string]any) string {
	p := str(args, "path", "")
	oldS := str(args, "old_string", "")
	if oldS == "" {
		oldS = str(args, "oldString", "")
	}
	if oldS == "" {
		oldS = str(args, "old", "")
	}
	newS := str(args, "new_string", "")
	if args["new_string"] == nil && args["newString"] != nil {
		newS = str(args, "newString", "")
	}
	if args["new_string"] == nil && args["newString"] == nil && args["new"] != nil {
		newS = str(args, "new", "")
	}
	_, hasNew := args["new_string"]
	if !hasNew {
		_, hasNew = args["newString"]
	}
	if !hasNew {
		_, hasNew = args["new"]
	}
	replaceAll := false
	if v, ok := args["replace_all"]; ok {
		if b, ok := v.(bool); ok {
			replaceAll = b
		} else if s, ok := v.(string); ok && (s == "true" || s == "1") {
			replaceAll = true
		}
	}
	if v, ok := args["replaceAll"]; ok && !replaceAll {
		if b, ok := v.(bool); ok {
			replaceAll = b
		}
	}
	if p == "" {
		return "ERROR: empty path"
	}
	if oldS == "" {
		return "ERROR: empty old_string — provide the exact text to replace"
	}
	if !hasNew {
		return "ERROR: missing new_string — provide replacement text (empty string allowed for deletion)"
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return "ERROR: " + err.Error()
	}
	content := string(b)
	count := strings.Count(content, oldS)
	if count == 0 {
		return "ERROR: old_string not found in " + p
	}
	if count > 1 && !replaceAll {
		return fmt.Sprintf("ERROR: old_string found %d times in %s — provide more surrounding context to make it unique, or set replace_all=true", count, p)
	}
	if replaceAll {
		content = strings.ReplaceAll(content, oldS, newS)
	} else {
		content = strings.Replace(content, oldS, newS, 1)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		return "ERROR: " + err.Error()
	}
	if replaceAll {
		return fmt.Sprintf("edited %s: replaced %d occurrence(s)", p, count)
	}
	return fmt.Sprintf("edited %s: 1 occurrence replaced", p)
}
func toolFileList(args map[string]any) string {
	p := str(args, "path", "/")
	es, err := os.ReadDir(p)
	if err != nil {
		return "ERROR: " + err.Error()
	}
	s := "listing " + p + ":\n"
	n := 0
	for _, e := range es {
		info, _ := e.Info()
		mark := "F"
		if e.IsDir() {
			mark = "D"
		}
		s += fmt.Sprintf("[%s] %s (%d bytes)\n", mark, e.Name(), info.Size())
		if n++; n > 100 {
			s += "...[truncated at 100 entries]"
			break
		}
	}
	return s
}


func toolGetTime(args map[string]any) string {
	tz := str(args, "timezone", "UTC")
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return "ERROR: bad timezone: " + tz
	}
	return time.Now().In(loc).Format(time.RFC3339) + " (" + tz + ")"
}

type parser struct{ s string; i int }

func (p *parser) skip() {
	for p.i < len(p.s) && (p.s[p.i] == ' ' || p.s[p.i] == '\t') {
		p.i++
	}
}
func (p *parser) num() (float64, error) {
	p.skip()
	j := p.i
	for j < len(p.s) && ((p.s[j] >= '0' && p.s[j] <= '9') || p.s[j] == '.') {
		j++
	}
	if j == p.i {
		return 0, fmt.Errorf("expected number at %d", p.i)
	}
	var f float64
	_, err := fmt.Sscanf(p.s[p.i:j], "%f", &f)
	p.i = j
	return f, err
}
func (p *parser) prim() (float64, error) {
	p.skip()
	if p.i < len(p.s) && p.s[p.i] == '(' {
		p.i++
		v, err := p.add()
		if err != nil {
			return 0, err
		}
		p.skip()
		if p.i >= len(p.s) || p.s[p.i] != ')' {
			return 0, fmt.Errorf("missing )")
		}
		p.i++
		return v, nil
	}
	if p.i < len(p.s) && (p.s[p.i] == '-' || p.s[p.i] == '+') {
		neg := p.s[p.i] == '-'
		p.i++
		v, err := p.prim()
		if err != nil {
			return 0, err
		}
		if neg {
			v = -v
		}
		return v, nil
	}
	return p.num()
}
func (p *parser) pw() (float64, error) {
	v, err := p.prim()
	if err != nil {
		return 0, err
	}
	p.skip()
	if p.i < len(p.s) && p.s[p.i] == '^' {
		p.i++
		e, err := p.pw()
		if err != nil {
			return 0, err
		}
		v = math.Pow(v, e)
	}
	return v, nil
}
func (p *parser) mul() (float64, error) {
	v, err := p.pw()
	if err != nil {
		return 0, err
	}
	for {
		p.skip()
		if p.i < len(p.s) && (p.s[p.i] == '*' || p.s[p.i] == '/' || p.s[p.i] == '%') {
			op := p.s[p.i]
			p.i++
			r, err := p.pw()
			if err != nil {
				return 0, err
			}
			switch op {
			case '*':
				v *= r
			case '/':
				if r == 0 {
					return 0, fmt.Errorf("div by zero")
				}
				v /= r
			case '%':
				v = float64(int(v) % int(r))
			}
		} else {
			return v, nil
		}
	}
}
func (p *parser) add() (float64, error) {
	v, err := p.mul()
	if err != nil {
		return 0, err
	}
	for {
		p.skip()
		if p.i < len(p.s) && (p.s[p.i] == '+' || p.s[p.i] == '-') {
			op := p.s[p.i]
			p.i++
			r, err := p.mul()
			if err != nil {
				return 0, err
			}
			if op == '+' {
				v += r
			} else {
				v -= r
			}
		} else {
			return v, nil
		}
	}
}
func toolCalc(args map[string]any) string {
	expr := str(args, "expression", "")
	if expr == "" {
		return "ERROR: empty expression"
	}
	p := &parser{s: expr}
	v, err := p.add()
	if err != nil {
		return "ERROR: " + err.Error()
	}
	p.skip()
	if p.i != len(p.s) {
		return fmt.Sprintf("ERROR: unexpected char at %d", p.i)
	}
	return fmt.Sprintf("%s = %v", expr, v)
}

func toolFetch(args map[string]any) string {
	url := str(args, "url", "")
	if url == "" {
		return "ERROR: empty url"
	}
	c := httpClient(20 * time.Second)
	resp, err := c.Get(url)
	if err != nil {
		return "ERROR: " + err.Error()
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 8000))
	return fmt.Sprintf("HTTP %d\n%s", resp.StatusCode, string(b))
}


var (
	reTitle = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	reMeta  = regexp.MustCompile(`(?is)<meta\s+[^>]*>`)
	reH1    = regexp.MustCompile(`(?is)<h1[^>]*>`)
	reH2    = regexp.MustCompile(`(?is)<h2[^>]*>`)
	reA     = regexp.MustCompile(`(?is)<a\s+[^>]*href=`)
	reTag   = regexp.MustCompile(`(?s)<[^>]+>`)
)

func toolWebCheck(args map[string]any) string {
	raw := str(args, "url", "")
	if raw == "" {
		return "ERROR: empty url"
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "ERROR: bad url: " + raw
	}
	start := time.Now()
	c := httpClient(20 * time.Second)
	req, _ := http.NewRequest("GET", raw, nil)
req.Header.Set("User-Agent", "hextelegram/web_check (+telegram)")
	resp, err := c.Do(req)
	if err != nil {
		return fmt.Sprintf("SITE: %s\nSTATUS: DOWN / unreachable\nERROR: %s\nHINT: DNS fail, timeout, or connection refused. Try shell_exec ping/nslookup/curl.", u.Host, err.Error())
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 200000))
	html := string(b)
	title := ""
	if m := reTitle.FindStringSubmatch(html); m != nil {
		title = strings.TrimSpace(reTag.ReplaceAllString(m[1], ""))
	}
	desc := ""
	for _, tag := range reMeta.FindAllString(html, 50) {
		lt := strings.ToLower(tag)
		if strings.Contains(lt, `name="description"`) || strings.Contains(lt, `property="og:description"`) {
			if m := regexp.MustCompile(`(?i)content="([^"]*)"`).FindStringSubmatch(tag); m != nil {
				desc = strings.TrimSpace(m[1])
				break
			}
		}
	}
	lh := strings.ToLower(html)
	hints := []string{}
	for _, k := range []string{"wp-content", "wordpress", "next.js", "__next", "nuxt", "laravel", "django", "rails", "shopify", "cloudflare", "vercel", "netlify", "php", "react", "vue", "angular"} {
		if strings.Contains(lh, k) {
			hints = append(hints, k)
		}
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "SITE: %s\nURL: %s\nFINAL_URL: %s\nSTATUS: HTTP %d (%s)\nTIME: %v\n", u.Host, raw, resp.Request.URL.String(), resp.StatusCode, http.StatusText(resp.StatusCode), time.Since(start).Round(time.Millisecond))
	if v := resp.Header.Get("Server"); v != "" {
		fmt.Fprintf(&sb, "SERVER: %s\n", v)
	}
	if v := resp.Header.Get("X-Powered-By"); v != "" {
		fmt.Fprintf(&sb, "POWERED_BY: %s\n", v)
	}
	if v := resp.Header.Get("Content-Type"); v != "" {
		fmt.Fprintf(&sb, "CONTENT_TYPE: %s\n", v)
	}
	if title != "" {
		fmt.Fprintf(&sb, "TITLE: %s\n", title)
	}
	if desc != "" {
		if len(desc) > 300 {
			desc = desc[:300] + "…"
		}
		fmt.Fprintf(&sb, "DESCRIPTION: %s\n", desc)
	}
	fmt.Fprintf(&sb, "SIZE: %d bytes (first 200KB scanned)\nH1: %d | H2: %d | LINKS: %d\n", len(b), len(reH1.FindAllString(html, -1)), len(reH2.FindAllString(html, -1)), len(reA.FindAllString(html, -1)))
	if len(hints) > 0 {
		fmt.Fprintf(&sb, "TECH_HINTS: %s\n", strings.Join(hints, ", "))
	}
	text := strings.TrimSpace(reTag.ReplaceAllString(html, " "))
	text = strings.Join(strings.Fields(text), " ")
	if len(text) > 600 {
		text = text[:600] + "…"
	}
	if text != "" {
		fmt.Fprintf(&sb, "SNIPPET: %s\n", text)
	}
	if resp.StatusCode >= 400 {
		sb.WriteString("NOTE: site returned an error status — do NOT invent content; report it as down/error.\n")
	}
	return sb.String()
}


func toolWebScreenshot(args map[string]any) string {
	raw := str(args, "url", "")
	if raw == "" {
		return "ERROR: empty url"
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	width := int(num(args, "width", 1280))
	height := int(num(args, "height", 800))
	if width < 320 {
		width = 1280
	}
	if height < 200 {
		height = 800
	}
	timeout := time.Duration(num(args, "timeoutSec", 30)) * time.Second
	if timeout < 5*time.Second {
		timeout = 30 * time.Second
	}
	if timeout > 2*time.Minute {
		timeout = 2 * time.Minute
	}
	bin := ""
	for _, c := range []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "/snap/bin/chromium"} {
		if p, err := exec.LookPath(c); err == nil {
			bin = p
			break
		}
	}
	if bin == "" {
		if _, err := os.Stat("/snap/bin/chromium"); err == nil {
			bin = "/snap/bin/chromium"
		}
	}
	if bin == "" {
		return "ERROR: no chromium found (tried chromium, chromium-browser, google-chrome). Install chromium to enable screenshots, or use web_check + web_fetch instead."
	}


	outDir := ""
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		snapDir := filepath.Join(h, "snap", "chromium", "common", "tgshots")
		if _, err := os.Stat(filepath.Join(h, "snap", "chromium")); err == nil {
			outDir = snapDir
		}
	}
	if outDir == "" {
		outDir = filepath.Join(".", "shots")
	}
	_ = os.MkdirAll(outDir, 0o755)
	out := filepath.Join(outDir, fmt.Sprintf("shot-%d.png", time.Now().UnixNano()))
	cmd := exec.Command(bin, "--headless", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
		"--disable-dbus", "--hide-scrollbars",
		fmt.Sprintf("--window-size=%d,%d", width, height), "--screenshot="+out, raw)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	done := make(chan error, 1)
	go func() { done <- cmd.Run() }()
	select {
	case err := <-done:
		if err != nil {
			return fmt.Sprintf("ERROR: screenshot failed: %s\nSTDERR: %s", err.Error(), errb.String())
		}
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		return "ERROR: screenshot timeout"
	}
	fi, err := os.Stat(out)
	if err != nil || fi.Size() == 0 {


		if alt, aerr := findRecentScreenshot(outDir); aerr == nil {
			out = alt
			fi, err = os.Stat(out)
		}
	}
	if err != nil || fi.Size() == 0 {
		msg := "ERROR: screenshot produced no file at " + out
		if errb.Len() > 0 {
			s := errb.String()
			if len(s) > 500 {
				s = s[:500]
			}
			msg += "\nSTDERR: " + s
		}
		return msg
	}
	return fmt.Sprintf("SCREENSHOT: %s (%d bytes, %dx%d)\nSend it with tg_send_photo using this local path.", out, fi.Size(), width, height)
}


func findRecentScreenshot(dir string) (string, error) {
	cands := []string{"screenshot.png"}
	es, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	for _, e := range es {
		n := e.Name()
		if strings.HasPrefix(n, "shot-") && strings.HasSuffix(n, ".png") {
			cands = append(cands, n)
		}
	}
	var best string
	var bestT time.Time
	for _, n := range cands {
		fi, err := os.Stat(filepath.Join(dir, n))
		if err != nil || fi.Size() == 0 || time.Since(fi.ModTime()) > 2*time.Minute {
			continue
		}
		if fi.ModTime().After(bestT) {
			bestT = fi.ModTime()
			best = n
		}
	}
	if best == "" {
		return "", fmt.Errorf("no recent screenshot in %s", dir)
	}
	dst := filepath.Join(dir, fmt.Sprintf("shot-%d.png", time.Now().UnixNano()))
	if best != filepath.Base(dst) {
		if err := os.Rename(filepath.Join(dir, best), dst); err != nil {
			return filepath.Join(dir, best), nil
		}
		return dst, nil
	}
	return filepath.Join(dir, best), nil
}


var (
	reBingAlgo = regexp.MustCompile(`(?is)<li[^>]+class="b_algo"[^>]*>(.*?)</li>`)
	reBingH2   = regexp.MustCompile(`(?is)<h2[^>]*>(.*?)</h2>`)
	reBingHref = regexp.MustCompile(`(?is)<a[^>]+href="([^"]+)"[^>]*>`)
	reBingCap  = regexp.MustCompile(`(?is)<div[^>]+class="b_caption"[^>]*>.*?<p[^>]*>(.*?)</p>`)
)


func bingRealURL(href string) string {
	href = strings.ReplaceAll(href, "&amp;", "&")
	if !strings.Contains(href, "/ck/a") {
		return href
	}
	u, err := url.Parse(href)
	if err != nil {
		return href
	}
	enc := u.Query().Get("u")
	if !strings.HasPrefix(enc, "a1") || len(enc) < 6 {
		return href
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc[2:])
	if err != nil {
		if raw2, err2 := base64.URLEncoding.DecodeString(enc[2:]); err2 == nil {
			raw = raw2
		} else {
			return href
		}
	}
	return string(raw)
}

func bingGet(c *http.Client, raw string) (string, error) {
	req, _ := http.NewRequest("GET", raw, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 500000))
	return string(b), nil
}

var reNumEnt = regexp.MustCompile(`&#(\d+);`)

func cleanText(s string) string {
	s = reTag.ReplaceAllString(s, " ")
	s = reNumEnt.ReplaceAllStringFunc(s, func(m string) string {
		var n int
		fmt.Sscanf(m, "&#%d;", &n)
		if n == 183 {
			return "·"
		}
		if n >= 32 && n < 127 {
			return string(rune(n))
		}
		return " "
	})
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&quot;", `"`)
	s = strings.ReplaceAll(s, "&#x27;", "'")
	s = strings.ReplaceAll(s, "&#39;", "'")
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&nbsp;", " ")
	return strings.TrimSpace(strings.Join(strings.Fields(s), " "))
}

func toolWebSearch(args map[string]any) string {
	q := strings.TrimSpace(str(args, "query", ""))
	if q == "" {
		return "ERROR: empty query"
	}
	max := int(num(args, "max", 8))
	if max < 1 {
		max = 8
	}
	if max > 15 {
		max = 15
	}
	c := httpClient(25 * time.Second)
	html, err := bingGet(c, "https://www.bing.com/search?q="+url.QueryEscape(q))
	if err != nil {
		return fmt.Sprintf("SEARCH FAILED for %q: %s. Try web_fetch on a likely site, or shell_exec curl.", q, err.Error())
	}
	type hit struct{ title, url, snip string }
	var hits []hit
	seen := map[string]bool{}
	for _, block := range reBingAlgo.FindAllStringSubmatch(html, max*3) {
		inner := block[1]
		href := ""
		if m := reBingHref.FindStringSubmatch(inner); m != nil {
			href = bingRealURL(m[1])
		}
		if href == "" || !strings.HasPrefix(href, "http") || seen[href] {
			continue
		}
		if strings.Contains(href, "bing.com") || strings.Contains(href, "microsoft.com") {
			continue
		}
		seen[href] = true
		title := ""
		if m := reBingH2.FindStringSubmatch(inner); m != nil {
			title = cleanText(m[1])
		}
		snip := ""
		if m := reBingCap.FindStringSubmatch(inner); m != nil {
			snip = cleanText(m[1])
		}
		if title == "" {
			title = href
		}
		hits = append(hits, hit{title: title, url: href, snip: snip})
		if len(hits) >= max {
			break
		}
	}
	var sb strings.Builder
	for i, h := range hits {
		t := h.title
		if len(t) > 160 {
			t = t[:160] + "…"
		}
		fmt.Fprintf(&sb, "%d. %s\n   %s\n", i+1, t, h.url)
		if len(h.snip) > 20 {
			s := h.snip
			if len(s) > 250 {
				s = s[:250] + "…"
			}
			fmt.Fprintf(&sb, "   %s\n", s)
		}
	}
	if len(hits) == 0 {
		return fmt.Sprintf("SEARCH: %q returned no parseable results (Bing may have changed layout). Try a different query or web_fetch directly.", q)
	}
	return fmt.Sprintf("SEARCH: %q (%d result%s)\n%s", q, len(hits), map[bool]string{true: "s", false: ""}[len(hits) != 1], sb.String())
}

func toolSysinfo() string {
	h, _ := host.Info()
	c, _ := cpu.Info()
	m, _ := mem.VirtualMemory()
	d, _ := disk.Usage("/")
	model := ""
	if len(c) > 0 {
		model = c[0].ModelName
	}
	pct := func(a, b uint64) float64 {
		if b == 0 {
			return 0
		}
		return float64(a) * 100 / float64(b)
	}
	return fmt.Sprintf("OS: %s %s | arch: %s | host: %s | CPU: %s x%d | mem: %.1f%% | disk /: %.1f%%",
		h.Platform, h.PlatformVersion, runtime.GOARCH, h.Hostname, model, runtime.NumCPU(),
		pct(m.Used, m.Total), d.UsedPercent)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: tools '{\"name\":\"shell_exec\",\"args\":{\"command\":\"ls\"}}'")
		os.Exit(1)
	}
	var c Call
	if err := json.Unmarshal([]byte(os.Args[1]), &c); err != nil {
		fmt.Println("ERROR: bad JSON: " + err.Error())
		os.Exit(1)
	}
	if c.Args == nil {
		c.Args = map[string]any{}
	}
	switch c.Name {
	case "shell_exec":
		fmt.Println(toolShell(c.Args))
	case "file_read":
		fmt.Println(toolFileRead(c.Args))
	case "file_write":
		fmt.Println(toolFileWrite(c.Args))
	case "file_edit":
		fmt.Println(toolFileEdit(c.Args))
	case "file_list":
		fmt.Println(toolFileList(c.Args))
	case "get_time":
		fmt.Println(toolGetTime(c.Args))
	case "calc":
		fmt.Println(toolCalc(c.Args))
	case "web_fetch":
		fmt.Println(toolFetch(c.Args))
	case "web_check":
		fmt.Println(toolWebCheck(c.Args))
	case "web_screenshot":
		fmt.Println(toolWebScreenshot(c.Args))
	case "web_search":
		fmt.Println(toolWebSearch(c.Args))
	case "sysinfo":
		fmt.Println(toolSysinfo())
	default:
		fmt.Println("ERROR: unknown tool: " + c.Name + " (tg_* tools run inside Node, not Go)")
		os.Exit(1)
	}
}
