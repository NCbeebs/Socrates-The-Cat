//! Maps Cursor/VS Code HWND → Habitat surfaces via UI Automation.
//! Window discovery: `ElementFromHandle` on the tracked HWND with exact native-handle validation;
//! tree walk uses `FindAll(Children)` per node (raw `UITreeWalker` missed nodes).

#[cfg(windows)]
mod imp {
    use uiautomation::types::{ControlType, Handle, TreeScope};
    use uiautomation::{UIAutomation, UIElement};
    use windows::Win32::Foundation::HWND;

    const MAX_DEPTH: u32 = 16;
    const MAX_NODES: usize = 4000;
    const CHROME_TOP: f64 = 80.0;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MonacoSashOrientation {
        Horizontal,
        Vertical,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum MonacoSashKind {
        NotMonaco,
        Disabled,
        Active(MonacoSashOrientation),
    }

    fn monaco_sash_kind(class_name: &str) -> MonacoSashKind {
        let c = class_name.to_ascii_lowercase();
        if !c.contains("monaco-sash") {
            return MonacoSashKind::NotMonaco;
        }
        if c.split_whitespace().any(|t| t == "disabled") {
            return MonacoSashKind::Disabled;
        }
        if c.contains("horizontal") {
            MonacoSashKind::Active(MonacoSashOrientation::Horizontal)
        } else if c.contains("vertical") {
            MonacoSashKind::Active(MonacoSashOrientation::Vertical)
        } else {
            MonacoSashKind::NotMonaco
        }
    }

    /// Whether to cache horizontal / vertical sash elements for this node.
    fn sash_cache_flags(
        node: &UiaNode,
        class_name: Option<&str>,
        client_w: f64,
        client_h: f64,
    ) -> (bool, bool) {
        match class_name.map(monaco_sash_kind) {
            Some(MonacoSashKind::Disabled) => (false, false),
            Some(MonacoSashKind::Active(MonacoSashOrientation::Horizontal)) => {
                (is_horizontal_panel_sash(node, client_w, true), false)
            }
            Some(MonacoSashKind::Active(MonacoSashOrientation::Vertical)) => {
                (false, is_vertical_wall_node(node, client_h, true))
            }
            _ => (
                is_horizontal_panel_sash(node, client_w, false),
                is_vertical_wall_node(node, client_h, false),
            ),
        }
    }

    fn element_passes_sash_cache(
        node: &UiaNode,
        class_name: Option<&str>,
        client_w: f64,
        client_h: f64,
        want_horizontal: bool,
    ) -> bool {
        let (h, v) = sash_cache_flags(node, class_name, client_w, client_h);
        if want_horizontal {
            h
        } else {
            v
        }
    }

    const EDITOR_TAB_SCORE_BASE: f64 = 1000.0;

    fn tab_container_editor_bonus(class_name: &str) -> Option<f64> {
        let c = class_name.to_ascii_lowercase();
        if c.contains("tabs-container") && c.contains("terminal") {
            return Some(-1.0);
        }
        if c.contains("tabs-container") {
            return Some(EDITOR_TAB_SCORE_BASE);
        }
        None
    }

    struct UiaNode {
        control_type: ControlType,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    fn rect_screen_dims(rect: &uiautomation::types::Rect) -> (f64, f64, f64, f64) {
        let x = rect.get_left() as f64;
        let y = rect.get_top() as f64;
        let w = (rect.get_right() - rect.get_left()) as f64;
        let h = (rect.get_bottom() - rect.get_top()) as f64;
        (x, y, w, h)
    }

    fn handles_match(a: Handle, hwnd: HWND) -> bool {
        let ah: isize = a.into();
        ah == hwnd.0 as isize
    }

    /// Resolves the UIA root for the tracked IDE HWND (`LiveUiaSession::connect` / `rediscover_window`,
    /// driven by the live thread in `lib.rs` on every IDE window swap). Direct `ElementFromHandle`
    /// yields the same element and subtree as a desktop → `ProcessId` search, but a desktop search
    /// queries every top-level window and one unresponsive app stalls it for tens of seconds —
    /// leaving the overlay on the old window's ledges and `habitat-pet.ts` rejecting pointer
    /// samples as `hwnd_mismatch` until geometry for the new HWND arrives.
    fn resolve_uia_window(automation: &UIAutomation, hwnd: HWND) -> Result<UIElement, String> {
        let window = automation
            .element_from_handle(Handle::from(hwnd.0 as isize))
            .map_err(|e| format!("element_from_handle: {}", e))?;
        if !window_element_valid(&window, hwnd) {
            return Err(format!(
                "UIA element for hwnd {} has no matching native handle",
                hwnd.0 as isize
            ));
        }
        Ok(window)
    }

    /// Depth-first walk (`FindAll(Children)` per node).
    /// Editor tab strip vs activity-bar `ControlType::Tab` (tall/narrow).
    fn score_editor_tab_strip(n: &UiaNode, class_name: Option<&str>) -> f64 {
        if n.control_type != ControlType::Tab {
            return -1.0;
        }
        if let Some(c) = class_name {
            if let Some(bonus) = tab_container_editor_bonus(c) {
                if bonus < 0.0 {
                    return -1.0;
                }
                return bonus + n.w / n.h.max(1.0);
            }
        }
        let w = n.w;
        let h = n.h.max(1.0);
        if w < 72.0 && h > w * 1.4 {
            return -1.0;
        }
        if w < 120.0 || h > 64.0 {
            return -1.0;
        }
        w / h
    }

    /// Cursor/VS Code expose more than one `ControlType::StatusBar`; the window status bar is the
    /// wide one flush with the client bottom. Full and cached scans must agree on this element or
    /// `platform-statusbar-top` flips Y every full scan and the pet (`habitat-pet.ts`) follows it.
    fn score_window_status_bar(n: &UiaNode, client_w: f64, client_h: f64) -> Option<f64> {
        if n.control_type != ControlType::StatusBar || n.w <= 0.0 || n.h <= 0.0 {
            return None;
        }
        let bottom_gap = (client_h - (n.y + n.h)).abs();
        Some(n.w.min(client_w) - 4.0 * bottom_gap)
    }

    fn is_horizontal_panel_sash(n: &UiaNode, client_w: f64, monaco_horizontal: bool) -> bool {
        if monaco_horizontal {
            return n.h <= 24.0 && n.w >= 48.0;
        }
        let min_w = 200f64.max(client_w * 0.15);
        if n.control_type != ControlType::Group || !sash_h(n.h) {
            return false;
        }
        if n.w <= min_w || n.y < CHROME_TOP || n.w > client_w * 0.95 {
            return false;
        }
        true
    }

    fn is_vertical_wall_node(n: &UiaNode, client_h: f64, monaco_vertical: bool) -> bool {
        if monaco_vertical {
            return n.w <= 24.0 && n.h > client_h * 0.15;
        }
        n.control_type == ControlType::Group && sash_w(n.w) && n.h > client_h * 0.35
    }

    fn horizontal_sash_surface(n: &UiaNode) -> super::MappedSurface {
        let y = n.y.round();
        let id = format!("ledge-h-{}", y as i32);
        super::MappedSurface {
            id,
            role: "ledge".into(),
            a: super::Point2 { x: n.x.round(), y },
            b: super::Point2 {
                x: (n.x + n.w).round(),
                y,
            },
            confidence: 0.90,
            walkable: true,
            climbable: false,
        }
    }

    fn vertical_wall_surface(n: &UiaNode) -> super::MappedSurface {
        let cx = (n.x + n.w / 2.0).round();
        let id = format!("wall-v-{}", cx as i32);
        super::MappedSurface {
            id,
            role: "wall".into(),
            a: super::Point2 {
                x: cx,
                y: n.y.round(),
            },
            b: super::Point2 {
                x: cx,
                y: (n.y + n.h).round(),
            },
            confidence: 0.92,
            walkable: false,
            climbable: true,
        }
    }

    fn status_bar_surface(n: &UiaNode) -> super::MappedSurface {
        let y = n.y.round();
        super::MappedSurface {
            id: "platform-statusbar-top".into(),
            role: "platform".into(),
            a: super::Point2 { x: n.x.round(), y },
            b: super::Point2 {
                x: (n.x + n.w).round(),
                y,
            },
            confidence: 0.95,
            walkable: true,
            climbable: false,
        }
    }

    fn tab_strip_surface(n: &UiaNode) -> super::MappedSurface {
        let y = n.y.round();
        super::MappedSurface {
            id: "ledge-tab-strip-top".into(),
            role: "ledge".into(),
            a: super::Point2 { x: n.x.round(), y },
            b: super::Point2 {
                x: (n.x + n.w).round(),
                y,
            },
            confidence: 0.88,
            walkable: true,
            climbable: false,
        }
    }

    fn explorer_top_surface(n: &UiaNode) -> super::MappedSurface {
        let y = n.y.round();
        super::MappedSurface {
            id: "ledge-explorer-top".into(),
            role: "ledge".into(),
            a: super::Point2 { x: n.x.round(), y },
            b: super::Point2 {
                x: (n.x + n.w).round(),
                y,
            },
            confidence: 0.75,
            walkable: true,
            climbable: false,
        }
    }

    /// Same segment order as `map_surfaces_from_window` (full walk) so revision compares stay stable.
    fn assemble_surfaces_ordered(
        walls: Vec<super::MappedSurface>,
        horizontal: Vec<super::MappedSurface>,
        statusbar: Option<super::MappedSurface>,
        tab: Option<super::MappedSurface>,
        tree: Option<super::MappedSurface>,
    ) -> Vec<super::MappedSurface> {
        let mut out = walls;
        out.extend(horizontal);
        if let Some(s) = statusbar {
            out.push(s);
        }
        if let Some(t) = tab {
            out.push(t);
        }
        if let Some(t) = tree {
            out.push(t);
        }
        out
    }

    fn element_to_local_node(
        element: &UIElement,
        origin_x: f64,
        origin_y: f64,
    ) -> Result<UiaNode, String> {
        let rect = element
            .get_bounding_rectangle()
            .map_err(|_| "element bounding rect failed".to_string())?;
        let (x, y, w, h) = rect_screen_dims(&rect);
        let control_type = element
            .get_control_type()
            .map_err(|_| "element control type failed".to_string())?;
        Ok(UiaNode {
            control_type,
            x: x - origin_x,
            y: y - origin_y,
            w,
            h,
        })
    }

    fn walk(
        element: &UIElement,
        automation: &UIAutomation,
        depth: u32,
        origin_x: f64,
        origin_y: f64,
        client_w: f64,
        client_h: f64,
        nodes: &mut Vec<UiaNode>,
        horizontal_sashes: &mut Vec<UIElement>,
        vertical_walls: &mut Vec<UIElement>,
        status_bar: &mut Option<UIElement>,
        status_bar_best_score: &mut f64,
        tab: &mut Option<UIElement>,
        tab_best_score: &mut f64,
        tree: &mut Option<UIElement>,
        budget: &mut usize,
    ) {
        if depth > MAX_DEPTH || *budget == 0 {
            return;
        }

        if let Ok(rect) = element.get_bounding_rectangle() {
            let (x, y, w, h) = rect_screen_dims(&rect);
            if let Ok(ct) = element.get_control_type() {
                let node = UiaNode {
                    control_type: ct,
                    x: x - origin_x,
                    y: y - origin_y,
                    w,
                    h,
                };
                let element_class = element.get_classname().ok();
                let (cache_h, cache_v) =
                    sash_cache_flags(&node, element_class.as_deref(), client_w, client_h);
                if cache_h {
                    horizontal_sashes.push(element.clone());
                }
                if cache_v {
                    vertical_walls.push(element.clone());
                }
                if let Some(score) = score_window_status_bar(&node, client_w, client_h) {
                    if score > *status_bar_best_score {
                        *status_bar_best_score = score;
                        *status_bar = Some(element.clone());
                    }
                }
                let tab_score = score_editor_tab_strip(&node, element_class.as_deref());
                if tab_score > *tab_best_score {
                    *tab_best_score = tab_score;
                    *tab = Some(element.clone());
                }
                if node.control_type == ControlType::Tree && tree.is_none() {
                    *tree = Some(element.clone());
                }
                nodes.push(node);
            }
        }
        *budget -= 1;

        let true_cond = match automation.create_true_condition() {
            Ok(c) => c,
            Err(_) => return,
        };
        let children = match element.find_all(TreeScope::Children, &true_cond) {
            Ok(c) => c,
            Err(_) => return,
        };
        for child in children {
            walk(
                &child,
                automation,
                depth + 1,
                origin_x,
                origin_y,
                client_w,
                client_h,
                nodes,
                horizontal_sashes,
                vertical_walls,
                status_bar,
                status_bar_best_score,
                tab,
                tab_best_score,
                tree,
                budget,
            );
        }
    }

    /// VS Code default sash thickness is 4px; Cursor often uses 5–8px.
    fn sash_w(w: f64) -> bool {
        let r = w.round().abs() as i32;
        (4..=9).contains(&r)
    }

    fn sash_h(h: f64) -> bool {
        let r = h.round().abs() as i32;
        (4..=9).contains(&r)
    }

    fn window_element_valid(window: &UIElement, hwnd: HWND) -> bool {
        if window.get_bounding_rectangle().is_err() {
            return false;
        }
        match window.get_native_window_handle() {
            Ok(native) => handles_match(native, hwnd),
            Err(_) => false,
        }
    }

    fn map_surfaces_from_window(
        automation: &UIAutomation,
        window: &UIElement,
        horizontal_sashes: &mut Vec<UIElement>,
        vertical_walls: &mut Vec<UIElement>,
        status_bar: &mut Option<UIElement>,
        tab: &mut Option<UIElement>,
        tree: &mut Option<UIElement>,
    ) -> Result<super::MappedSurfaces, String> {
        let uia_root = window
            .get_bounding_rectangle()
            .map_err(|e| format!("window bounding rect: {}", e))?;

        let uia_origin_x = uia_root.get_left() as f64;
        let uia_origin_y = uia_root.get_top() as f64;
        let client_w = (uia_root.get_right() - uia_root.get_left()) as f64;
        let client_h = (uia_root.get_bottom() - uia_root.get_top()) as f64;

        let mut nodes = Vec::new();
        let mut budget = MAX_NODES;
        let mut tab_best_score = -1.0_f64;
        let mut status_bar_best_score = f64::NEG_INFINITY;
        horizontal_sashes.clear();
        vertical_walls.clear();
        *status_bar = None;
        *tab = None;
        *tree = None;
        walk(
            window,
            automation,
            0,
            uia_origin_x,
            uia_origin_y,
            client_w,
            client_h,
            &mut nodes,
            horizontal_sashes,
            vertical_walls,
            status_bar,
            &mut status_bar_best_score,
            tab,
            &mut tab_best_score,
            tree,
            &mut budget,
        );

        let group_sash_like = nodes
            .iter()
            .filter(|n| n.control_type == ControlType::Group)
            .filter(|n| sash_w(n.w) || sash_h(n.h))
            .count();

        let walls: Vec<super::MappedSurface> = vertical_walls
            .iter()
            .filter_map(|el| {
                let class = el.get_classname().ok();
                element_to_local_node(el, uia_origin_x, uia_origin_y)
                    .ok()
                    .filter(|n| {
                        element_passes_sash_cache(n, class.as_deref(), client_w, client_h, false)
                    })
                    .map(|n| vertical_wall_surface(&n))
            })
            .collect();

        let horizontal: Vec<super::MappedSurface> = horizontal_sashes
            .iter()
            .filter_map(|el| {
                let class = el.get_classname().ok();
                element_to_local_node(el, uia_origin_x, uia_origin_y)
                    .ok()
                    .filter(|n| {
                        element_passes_sash_cache(n, class.as_deref(), client_w, client_h, true)
                    })
                    .map(|n| horizontal_sash_surface(&n))
            })
            .collect();

        let statusbar = status_bar.as_ref().and_then(|el| {
            element_to_local_node(el, uia_origin_x, uia_origin_y)
                .ok()
                .filter(|n| n.control_type == ControlType::StatusBar)
                .map(|n| status_bar_surface(&n))
        });
        let tab = tab.as_ref().and_then(|el| {
            let class = el.get_classname().ok();
            element_to_local_node(el, uia_origin_x, uia_origin_y)
                .ok()
                .filter(|n| score_editor_tab_strip(n, class.as_deref()) > 0.0)
                .map(|n| tab_strip_surface(&n))
        });
        let tree = nodes
            .iter()
            .find(|n| n.control_type == ControlType::Tree)
            .map(explorer_top_surface);

        let surfaces = assemble_surfaces_ordered(walls, horizontal, statusbar, tab, tree);

        Ok(super::MappedSurfaces {
            window_local_rect: super::WindowLocalRect {
                width: client_w,
                height: client_h,
            },
            surfaces,
            debug_node_count: nodes.len(),
            debug_group_sash_like: group_sash_like,
        })
    }

    /// Reused by the live UIA worker: one window lookup per HWND, then cheap tree walks.
    pub struct LiveUiaSession {
        hwnd: isize,
        automation: UIAutomation,
        window: UIElement,
        horizontal_sash_elements: Vec<UIElement>,
        vertical_wall_elements: Vec<UIElement>,
        status_bar_element: Option<UIElement>,
        tab_element: Option<UIElement>,
        tree_element: Option<UIElement>,
        last_full: Option<super::MappedSurfaces>,
    }

    impl LiveUiaSession {
        pub fn connect(hwnd: isize) -> Result<Self, String> {
            let automation =
                UIAutomation::new().map_err(|e| format!("UIAutomation::new: {}", e))?;
            let win = HWND(hwnd as *mut std::ffi::c_void);
            let window = resolve_uia_window(&automation, win)?;
            Ok(Self {
                hwnd,
                automation,
                window,
                horizontal_sash_elements: Vec::new(),
                vertical_wall_elements: Vec::new(),
                status_bar_element: None,
                tab_element: None,
                tree_element: None,
                last_full: None,
            })
        }

        pub fn hwnd(&self) -> isize {
            self.hwnd
        }

        fn rediscover_window(&mut self) -> Result<(), String> {
            let win = HWND(self.hwnd as *mut std::ffi::c_void);
            if window_element_valid(&self.window, win) {
                return Ok(());
            }
            match resolve_uia_window(&self.automation, win) {
                Ok(window) => {
                    self.window = window;
                    Ok(())
                }
                Err(_) => {
                    self.automation =
                        UIAutomation::new().map_err(|e| format!("UIAutomation::new: {}", e))?;
                    self.window = resolve_uia_window(&self.automation, win)?;
                    Ok(())
                }
            }
        }

        /// Full UIA tree walk; caches horizontal sash elements for `scan_fast`.
        pub fn scan_full(&mut self) -> Result<super::MappedSurfaces, String> {
            self.rediscover_window()?;
            let mapped = map_surfaces_from_window(
                &self.automation,
                &self.window,
                &mut self.horizontal_sash_elements,
                &mut self.vertical_wall_elements,
                &mut self.status_bar_element,
                &mut self.tab_element,
                &mut self.tree_element,
            )?;
            self.last_full = Some(mapped.clone());
            Ok(mapped)
        }

        /// Re-read bounds on cached UIA elements (~1–2 ms); same surface order as full walk.
        pub fn scan_fast(&mut self) -> Result<super::MappedSurfaces, String> {
            self.rediscover_window()?;
            let baseline = self
                .last_full
                .as_ref()
                .ok_or_else(|| "fast scan requires a prior full scan".to_string())?;

            let uia_root = self
                .window
                .get_bounding_rectangle()
                .map_err(|e| format!("window bounding rect: {}", e))?;
            let uia_origin_x = uia_root.get_left() as f64;
            let uia_origin_y = uia_root.get_top() as f64;
            let client_w = (uia_root.get_right() - uia_root.get_left()) as f64;
            let client_h = (uia_root.get_bottom() - uia_root.get_top()) as f64;

            if (client_w - baseline.window_local_rect.width).abs() > 1.0
                || (client_h - baseline.window_local_rect.height).abs() > 1.0
            {
                return Err("window size changed".into());
            }

            let mut walls = Vec::new();
            for el in &self.vertical_wall_elements {
                let node = element_to_local_node(el, uia_origin_x, uia_origin_y)?;
                let class = el.get_classname().ok();
                if element_passes_sash_cache(&node, class.as_deref(), client_w, client_h, false) {
                    walls.push(vertical_wall_surface(&node));
                } else {
                    return Err("vertical wall element no longer matches heuristics".into());
                }
            }

            let mut horizontal = Vec::new();
            for el in &self.horizontal_sash_elements {
                let node = element_to_local_node(el, uia_origin_x, uia_origin_y)?;
                let class = el.get_classname().ok();
                if element_passes_sash_cache(&node, class.as_deref(), client_w, client_h, true) {
                    horizontal.push(horizontal_sash_surface(&node));
                } else {
                    return Err("sash element no longer matches panel sash heuristics".into());
                }
            }

            let statusbar = self.status_bar_element.as_ref().and_then(|el| {
                element_to_local_node(el, uia_origin_x, uia_origin_y)
                    .ok()
                    .filter(|n| n.control_type == ControlType::StatusBar)
                    .map(|n| status_bar_surface(&n))
            });
            let tab = self.tab_element.as_ref().and_then(|el| {
                element_to_local_node(el, uia_origin_x, uia_origin_y)
                    .ok()
                    .filter(|n| score_editor_tab_strip(n, el.get_classname().ok().as_deref()) > 0.0)
                    .map(|n| tab_strip_surface(&n))
            });
            let tree = self.tree_element.as_ref().and_then(|el| {
                element_to_local_node(el, uia_origin_x, uia_origin_y)
                    .ok()
                    .filter(|n| n.control_type == ControlType::Tree)
                    .map(|n| explorer_top_surface(&n))
            });

            let surfaces = assemble_surfaces_ordered(walls, horizontal, statusbar, tab, tree);

            Ok(super::MappedSurfaces {
                window_local_rect: super::WindowLocalRect {
                    width: client_w,
                    height: client_h,
                },
                surfaces,
                debug_node_count: baseline.debug_node_count,
                debug_group_sash_like: baseline.debug_group_sash_like,
            })
        }
    }

    #[cfg(test)]
    mod heuristic_tests {
        use super::{
            is_horizontal_panel_sash, is_vertical_wall_node, monaco_sash_kind, sash_cache_flags,
            sash_h, sash_w, score_editor_tab_strip, score_window_status_bar, MonacoSashKind,
            UiaNode,
        };
        use uiautomation::types::ControlType;

        fn tab_node(w: f64, h: f64) -> UiaNode {
            UiaNode {
                control_type: ControlType::Tab,
                x: 0.0,
                y: 0.0,
                w,
                h,
            }
        }

        fn sash_node(w: f64, h: f64) -> UiaNode {
            UiaNode {
                control_type: ControlType::Group,
                x: 0.0,
                y: 0.0,
                w,
                h,
            }
        }

        #[test]
        fn sash_thickness_includes_vscode_default() {
            assert!(sash_w(4.0));
            assert!(sash_h(4.0));
            assert!(sash_w(8.0));
        }

        #[test]
        fn editor_tab_beats_activity_bar_tab() {
            let editor = score_editor_tab_strip(&tab_node(800.0, 36.0), None);
            let activity = score_editor_tab_strip(&tab_node(48.0, 600.0), None);
            assert!(editor > 0.0);
            assert!(activity < 0.0);
            assert!(editor > activity);
        }

        #[test]
        fn editor_tabs_container_beats_terminal_tabs() {
            let editor = score_editor_tab_strip(&tab_node(400.0, 35.0), Some("tabs-container"));
            let terminal =
                score_editor_tab_strip(&tab_node(900.0, 35.0), Some("terminal-tabs-container"));
            assert!(editor > terminal);
            assert!(terminal < 0.0);
        }

        #[test]
        fn monaco_semantic_sash_accepts_nonstandard_thickness() {
            assert_eq!(
                monaco_sash_kind("monaco-sash vertical"),
                MonacoSashKind::Active(super::MonacoSashOrientation::Vertical)
            );
            assert_eq!(
                monaco_sash_kind("monaco-sash vertical disabled"),
                MonacoSashKind::Disabled
            );
            let tall = sash_node(12.0, 800.0);
            assert!(is_vertical_wall_node(&tall, 900.0, true));
            let wide = sash_node(1200.0, 4.0);
            assert!(is_horizontal_panel_sash(&wide, 1200.0, true));
        }

        #[test]
        fn window_status_bar_beats_mid_window_status_bar() {
            let status = |x: f64, y: f64, w: f64, h: f64| UiaNode {
                control_type: ControlType::StatusBar,
                x,
                y,
                w,
                h,
            };
            let (client_w, client_h) = (2576.0, 1408.0);
            let window = score_window_status_bar(&status(0.0, 1371.0, 2576.0, 37.0), client_w, client_h);
            let panel = score_window_status_bar(&status(400.0, 1120.0, 2000.0, 30.0), client_w, client_h);
            assert!(window.unwrap() > panel.unwrap());
            assert!(score_window_status_bar(&tab_node(2576.0, 37.0), client_w, client_h).is_none());
        }

        #[test]
        fn disabled_monaco_sash_skips_generic_group_match() {
            let disabled = sash_node(4.0, 800.0);
            let (h, v) = sash_cache_flags(
                &disabled,
                Some("monaco-sash vertical disabled"),
                1200.0,
                900.0,
            );
            assert!(!h && !v);
            let (_, v_generic) = sash_cache_flags(&disabled, None, 1200.0, 900.0);
            assert!(v_generic);
        }
    }
}

#[cfg(windows)]
pub use imp::LiveUiaSession;

#[derive(Debug, Clone)]
pub struct Point2 {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone)]
pub struct MappedSurface {
    pub id: String,
    pub role: String,
    pub a: Point2,
    pub b: Point2,
    pub confidence: f64,
    pub walkable: bool,
    pub climbable: bool,
}

#[derive(Debug, Clone)]
pub struct MappedSurfaces {
    pub window_local_rect: WindowLocalRect,
    pub surfaces: Vec<MappedSurface>,
    pub debug_node_count: usize,
    pub debug_group_sash_like: usize,
}

#[derive(Debug, Clone)]
pub struct WindowLocalRect {
    pub width: f64,
    pub height: f64,
}
