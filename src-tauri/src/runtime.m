// A read-only preview when native content is covered by desktop chrome.
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
typedef void (*SnapshotCallback)(void *, const char *);
void sshdesk_runtime_snapshot(void *pointer, void *context, SnapshotCallback callback) {
    WKWebView *view = (__bridge WKWebView *)pointer;
    WKSnapshotConfiguration *config = [WKSnapshotConfiguration new];
    config.snapshotWidth = @(MIN(view.bounds.size.width, 1400));
    [view takeSnapshotWithConfiguration:config completionHandler:^(NSImage *image, NSError *error) {
        if (!image || error) { callback(context, ""); return; }
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        NSString *value = [png base64EncodedStringWithOptions:0];
        callback(context, value.UTF8String ?: "");
    }];
}
// Whether the user is actually in this view: only then may it move desktop focus.
bool sshdesk_runtime_focused(void *pointer) {
    WKWebView *view = (__bridge WKWebView *)pointer;
    NSResponder *responder = view.window.firstResponder;
    if (![responder isKindOfClass:[NSView class]]) return false;
    return responder == view || [(NSView *)responder isDescendantOf:view];
}
