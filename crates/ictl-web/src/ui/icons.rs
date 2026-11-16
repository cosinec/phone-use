use leptos::prelude::*;

/// One outline style for decorative interface icons. Controls supply their own names.
#[component]
pub(super) fn Icon(name: &'static str) -> impl IntoView {
    let path = match name {
        "phone" => "M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 3h4m-3 12h2",
        "grid" => "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z",
        "settings" => "M4 7h16M4 17h16M8 4v6m8 4v6",
        "sparkles" => "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7-1v4m-2-2h4",
        "activity" => "M4 5h16M4 12h4l2-4 4 8 2-4h4M4 19h16",
        "arrow-up-right" => "M6 18 18 6M6 6h12v12",
        "refresh" => "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18a8 8 0 0 1-13-2",
        "shield" => "M12 3 20 6v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
        "plug" => "M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v3",
        "home" => "m3 11 9-8 9 8M5 9v12h5v-7h4v7h5V9",
        "lock" => "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5V10Zm7 4v3",
        "minus" => "M5 12h14",
        "plus" => "M5 12h14M12 5v14",
        "back" => "m10 5-7 7 7 7M3 12h18",
        "stop" => "M6 6h12v12H6V6Z",
        "close" => "m6 6 12 12M6 18 18 6",
        "image" => "M3 3h18v18H3V3Zm0 14 5-5 4 4 3-3 6 6M7 7h2",
        _ => "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v6m0-10v1",
    };
    view! {
        <svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
            aria-hidden="true" focusable="false">
            <path d=path />
        </svg>
    }
}
