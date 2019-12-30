(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
/**
 * Copyright (c) 2014-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

var runtime = (function (exports) {
  "use strict";

  var Op = Object.prototype;
  var hasOwn = Op.hasOwnProperty;
  var undefined; // More compressible than void 0.
  var $Symbol = typeof Symbol === "function" ? Symbol : {};
  var iteratorSymbol = $Symbol.iterator || "@@iterator";
  var asyncIteratorSymbol = $Symbol.asyncIterator || "@@asyncIterator";
  var toStringTagSymbol = $Symbol.toStringTag || "@@toStringTag";

  function wrap(innerFn, outerFn, self, tryLocsList) {
    // If outerFn provided and outerFn.prototype is a Generator, then outerFn.prototype instanceof Generator.
    var protoGenerator = outerFn && outerFn.prototype instanceof Generator ? outerFn : Generator;
    var generator = Object.create(protoGenerator.prototype);
    var context = new Context(tryLocsList || []);

    // The ._invoke method unifies the implementations of the .next,
    // .throw, and .return methods.
    generator._invoke = makeInvokeMethod(innerFn, self, context);

    return generator;
  }
  exports.wrap = wrap;

  // Try/catch helper to minimize deoptimizations. Returns a completion
  // record like context.tryEntries[i].completion. This interface could
  // have been (and was previously) designed to take a closure to be
  // invoked without arguments, but in all the cases we care about we
  // already have an existing method we want to call, so there's no need
  // to create a new function object. We can even get away with assuming
  // the method takes exactly one argument, since that happens to be true
  // in every case, so we don't have to touch the arguments object. The
  // only additional allocation required is the completion record, which
  // has a stable shape and so hopefully should be cheap to allocate.
  function tryCatch(fn, obj, arg) {
    try {
      return { type: "normal", arg: fn.call(obj, arg) };
    } catch (err) {
      return { type: "throw", arg: err };
    }
  }

  var GenStateSuspendedStart = "suspendedStart";
  var GenStateSuspendedYield = "suspendedYield";
  var GenStateExecuting = "executing";
  var GenStateCompleted = "completed";

  // Returning this object from the innerFn has the same effect as
  // breaking out of the dispatch switch statement.
  var ContinueSentinel = {};

  // Dummy constructor functions that we use as the .constructor and
  // .constructor.prototype properties for functions that return Generator
  // objects. For full spec compliance, you may wish to configure your
  // minifier not to mangle the names of these two functions.
  function Generator() {}
  function GeneratorFunction() {}
  function GeneratorFunctionPrototype() {}

  // This is a polyfill for %IteratorPrototype% for environments that
  // don't natively support it.
  var IteratorPrototype = {};
  IteratorPrototype[iteratorSymbol] = function () {
    return this;
  };

  var getProto = Object.getPrototypeOf;
  var NativeIteratorPrototype = getProto && getProto(getProto(values([])));
  if (NativeIteratorPrototype &&
      NativeIteratorPrototype !== Op &&
      hasOwn.call(NativeIteratorPrototype, iteratorSymbol)) {
    // This environment has a native %IteratorPrototype%; use it instead
    // of the polyfill.
    IteratorPrototype = NativeIteratorPrototype;
  }

  var Gp = GeneratorFunctionPrototype.prototype =
    Generator.prototype = Object.create(IteratorPrototype);
  GeneratorFunction.prototype = Gp.constructor = GeneratorFunctionPrototype;
  GeneratorFunctionPrototype.constructor = GeneratorFunction;
  GeneratorFunctionPrototype[toStringTagSymbol] =
    GeneratorFunction.displayName = "GeneratorFunction";

  // Helper for defining the .next, .throw, and .return methods of the
  // Iterator interface in terms of a single ._invoke method.
  function defineIteratorMethods(prototype) {
    ["next", "throw", "return"].forEach(function(method) {
      prototype[method] = function(arg) {
        return this._invoke(method, arg);
      };
    });
  }

  exports.isGeneratorFunction = function(genFun) {
    var ctor = typeof genFun === "function" && genFun.constructor;
    return ctor
      ? ctor === GeneratorFunction ||
        // For the native GeneratorFunction constructor, the best we can
        // do is to check its .name property.
        (ctor.displayName || ctor.name) === "GeneratorFunction"
      : false;
  };

  exports.mark = function(genFun) {
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(genFun, GeneratorFunctionPrototype);
    } else {
      genFun.__proto__ = GeneratorFunctionPrototype;
      if (!(toStringTagSymbol in genFun)) {
        genFun[toStringTagSymbol] = "GeneratorFunction";
      }
    }
    genFun.prototype = Object.create(Gp);
    return genFun;
  };

  // Within the body of any async function, `await x` is transformed to
  // `yield regeneratorRuntime.awrap(x)`, so that the runtime can test
  // `hasOwn.call(value, "__await")` to determine if the yielded value is
  // meant to be awaited.
  exports.awrap = function(arg) {
    return { __await: arg };
  };

  function AsyncIterator(generator) {
    function invoke(method, arg, resolve, reject) {
      var record = tryCatch(generator[method], generator, arg);
      if (record.type === "throw") {
        reject(record.arg);
      } else {
        var result = record.arg;
        var value = result.value;
        if (value &&
            typeof value === "object" &&
            hasOwn.call(value, "__await")) {
          return Promise.resolve(value.__await).then(function(value) {
            invoke("next", value, resolve, reject);
          }, function(err) {
            invoke("throw", err, resolve, reject);
          });
        }

        return Promise.resolve(value).then(function(unwrapped) {
          // When a yielded Promise is resolved, its final value becomes
          // the .value of the Promise<{value,done}> result for the
          // current iteration.
          result.value = unwrapped;
          resolve(result);
        }, function(error) {
          // If a rejected Promise was yielded, throw the rejection back
          // into the async generator function so it can be handled there.
          return invoke("throw", error, resolve, reject);
        });
      }
    }

    var previousPromise;

    function enqueue(method, arg) {
      function callInvokeWithMethodAndArg() {
        return new Promise(function(resolve, reject) {
          invoke(method, arg, resolve, reject);
        });
      }

      return previousPromise =
        // If enqueue has been called before, then we want to wait until
        // all previous Promises have been resolved before calling invoke,
        // so that results are always delivered in the correct order. If
        // enqueue has not been called before, then it is important to
        // call invoke immediately, without waiting on a callback to fire,
        // so that the async generator function has the opportunity to do
        // any necessary setup in a predictable way. This predictability
        // is why the Promise constructor synchronously invokes its
        // executor callback, and why async functions synchronously
        // execute code before the first await. Since we implement simple
        // async functions in terms of async generators, it is especially
        // important to get this right, even though it requires care.
        previousPromise ? previousPromise.then(
          callInvokeWithMethodAndArg,
          // Avoid propagating failures to Promises returned by later
          // invocations of the iterator.
          callInvokeWithMethodAndArg
        ) : callInvokeWithMethodAndArg();
    }

    // Define the unified helper method that is used to implement .next,
    // .throw, and .return (see defineIteratorMethods).
    this._invoke = enqueue;
  }

  defineIteratorMethods(AsyncIterator.prototype);
  AsyncIterator.prototype[asyncIteratorSymbol] = function () {
    return this;
  };
  exports.AsyncIterator = AsyncIterator;

  // Note that simple async functions are implemented on top of
  // AsyncIterator objects; they just return a Promise for the value of
  // the final result produced by the iterator.
  exports.async = function(innerFn, outerFn, self, tryLocsList) {
    var iter = new AsyncIterator(
      wrap(innerFn, outerFn, self, tryLocsList)
    );

    return exports.isGeneratorFunction(outerFn)
      ? iter // If outerFn is a generator, return the full iterator.
      : iter.next().then(function(result) {
          return result.done ? result.value : iter.next();
        });
  };

  function makeInvokeMethod(innerFn, self, context) {
    var state = GenStateSuspendedStart;

    return function invoke(method, arg) {
      if (state === GenStateExecuting) {
        throw new Error("Generator is already running");
      }

      if (state === GenStateCompleted) {
        if (method === "throw") {
          throw arg;
        }

        // Be forgiving, per 25.3.3.3.3 of the spec:
        // https://people.mozilla.org/~jorendorff/es6-draft.html#sec-generatorresume
        return doneResult();
      }

      context.method = method;
      context.arg = arg;

      while (true) {
        var delegate = context.delegate;
        if (delegate) {
          var delegateResult = maybeInvokeDelegate(delegate, context);
          if (delegateResult) {
            if (delegateResult === ContinueSentinel) continue;
            return delegateResult;
          }
        }

        if (context.method === "next") {
          // Setting context._sent for legacy support of Babel's
          // function.sent implementation.
          context.sent = context._sent = context.arg;

        } else if (context.method === "throw") {
          if (state === GenStateSuspendedStart) {
            state = GenStateCompleted;
            throw context.arg;
          }

          context.dispatchException(context.arg);

        } else if (context.method === "return") {
          context.abrupt("return", context.arg);
        }

        state = GenStateExecuting;

        var record = tryCatch(innerFn, self, context);
        if (record.type === "normal") {
          // If an exception is thrown from innerFn, we leave state ===
          // GenStateExecuting and loop back for another invocation.
          state = context.done
            ? GenStateCompleted
            : GenStateSuspendedYield;

          if (record.arg === ContinueSentinel) {
            continue;
          }

          return {
            value: record.arg,
            done: context.done
          };

        } else if (record.type === "throw") {
          state = GenStateCompleted;
          // Dispatch the exception by looping back around to the
          // context.dispatchException(context.arg) call above.
          context.method = "throw";
          context.arg = record.arg;
        }
      }
    };
  }

  // Call delegate.iterator[context.method](context.arg) and handle the
  // result, either by returning a { value, done } result from the
  // delegate iterator, or by modifying context.method and context.arg,
  // setting context.delegate to null, and returning the ContinueSentinel.
  function maybeInvokeDelegate(delegate, context) {
    var method = delegate.iterator[context.method];
    if (method === undefined) {
      // A .throw or .return when the delegate iterator has no .throw
      // method always terminates the yield* loop.
      context.delegate = null;

      if (context.method === "throw") {
        // Note: ["return"] must be used for ES3 parsing compatibility.
        if (delegate.iterator["return"]) {
          // If the delegate iterator has a return method, give it a
          // chance to clean up.
          context.method = "return";
          context.arg = undefined;
          maybeInvokeDelegate(delegate, context);

          if (context.method === "throw") {
            // If maybeInvokeDelegate(context) changed context.method from
            // "return" to "throw", let that override the TypeError below.
            return ContinueSentinel;
          }
        }

        context.method = "throw";
        context.arg = new TypeError(
          "The iterator does not provide a 'throw' method");
      }

      return ContinueSentinel;
    }

    var record = tryCatch(method, delegate.iterator, context.arg);

    if (record.type === "throw") {
      context.method = "throw";
      context.arg = record.arg;
      context.delegate = null;
      return ContinueSentinel;
    }

    var info = record.arg;

    if (! info) {
      context.method = "throw";
      context.arg = new TypeError("iterator result is not an object");
      context.delegate = null;
      return ContinueSentinel;
    }

    if (info.done) {
      // Assign the result of the finished delegate to the temporary
      // variable specified by delegate.resultName (see delegateYield).
      context[delegate.resultName] = info.value;

      // Resume execution at the desired location (see delegateYield).
      context.next = delegate.nextLoc;

      // If context.method was "throw" but the delegate handled the
      // exception, let the outer generator proceed normally. If
      // context.method was "next", forget context.arg since it has been
      // "consumed" by the delegate iterator. If context.method was
      // "return", allow the original .return call to continue in the
      // outer generator.
      if (context.method !== "return") {
        context.method = "next";
        context.arg = undefined;
      }

    } else {
      // Re-yield the result returned by the delegate method.
      return info;
    }

    // The delegate iterator is finished, so forget it and continue with
    // the outer generator.
    context.delegate = null;
    return ContinueSentinel;
  }

  // Define Generator.prototype.{next,throw,return} in terms of the
  // unified ._invoke helper method.
  defineIteratorMethods(Gp);

  Gp[toStringTagSymbol] = "Generator";

  // A Generator should always return itself as the iterator object when the
  // @@iterator function is called on it. Some browsers' implementations of the
  // iterator prototype chain incorrectly implement this, causing the Generator
  // object to not be returned from this call. This ensures that doesn't happen.
  // See https://github.com/facebook/regenerator/issues/274 for more details.
  Gp[iteratorSymbol] = function() {
    return this;
  };

  Gp.toString = function() {
    return "[object Generator]";
  };

  function pushTryEntry(locs) {
    var entry = { tryLoc: locs[0] };

    if (1 in locs) {
      entry.catchLoc = locs[1];
    }

    if (2 in locs) {
      entry.finallyLoc = locs[2];
      entry.afterLoc = locs[3];
    }

    this.tryEntries.push(entry);
  }

  function resetTryEntry(entry) {
    var record = entry.completion || {};
    record.type = "normal";
    delete record.arg;
    entry.completion = record;
  }

  function Context(tryLocsList) {
    // The root entry object (effectively a try statement without a catch
    // or a finally block) gives us a place to store values thrown from
    // locations where there is no enclosing try statement.
    this.tryEntries = [{ tryLoc: "root" }];
    tryLocsList.forEach(pushTryEntry, this);
    this.reset(true);
  }

  exports.keys = function(object) {
    var keys = [];
    for (var key in object) {
      keys.push(key);
    }
    keys.reverse();

    // Rather than returning an object with a next method, we keep
    // things simple and return the next function itself.
    return function next() {
      while (keys.length) {
        var key = keys.pop();
        if (key in object) {
          next.value = key;
          next.done = false;
          return next;
        }
      }

      // To avoid creating an additional object, we just hang the .value
      // and .done properties off the next function object itself. This
      // also ensures that the minifier will not anonymize the function.
      next.done = true;
      return next;
    };
  };

  function values(iterable) {
    if (iterable) {
      var iteratorMethod = iterable[iteratorSymbol];
      if (iteratorMethod) {
        return iteratorMethod.call(iterable);
      }

      if (typeof iterable.next === "function") {
        return iterable;
      }

      if (!isNaN(iterable.length)) {
        var i = -1, next = function next() {
          while (++i < iterable.length) {
            if (hasOwn.call(iterable, i)) {
              next.value = iterable[i];
              next.done = false;
              return next;
            }
          }

          next.value = undefined;
          next.done = true;

          return next;
        };

        return next.next = next;
      }
    }

    // Return an iterator with no values.
    return { next: doneResult };
  }
  exports.values = values;

  function doneResult() {
    return { value: undefined, done: true };
  }

  Context.prototype = {
    constructor: Context,

    reset: function(skipTempReset) {
      this.prev = 0;
      this.next = 0;
      // Resetting context._sent for legacy support of Babel's
      // function.sent implementation.
      this.sent = this._sent = undefined;
      this.done = false;
      this.delegate = null;

      this.method = "next";
      this.arg = undefined;

      this.tryEntries.forEach(resetTryEntry);

      if (!skipTempReset) {
        for (var name in this) {
          // Not sure about the optimal order of these conditions:
          if (name.charAt(0) === "t" &&
              hasOwn.call(this, name) &&
              !isNaN(+name.slice(1))) {
            this[name] = undefined;
          }
        }
      }
    },

    stop: function() {
      this.done = true;

      var rootEntry = this.tryEntries[0];
      var rootRecord = rootEntry.completion;
      if (rootRecord.type === "throw") {
        throw rootRecord.arg;
      }

      return this.rval;
    },

    dispatchException: function(exception) {
      if (this.done) {
        throw exception;
      }

      var context = this;
      function handle(loc, caught) {
        record.type = "throw";
        record.arg = exception;
        context.next = loc;

        if (caught) {
          // If the dispatched exception was caught by a catch block,
          // then let that catch block handle the exception normally.
          context.method = "next";
          context.arg = undefined;
        }

        return !! caught;
      }

      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        var record = entry.completion;

        if (entry.tryLoc === "root") {
          // Exception thrown outside of any try block that could handle
          // it, so set the completion value of the entire function to
          // throw the exception.
          return handle("end");
        }

        if (entry.tryLoc <= this.prev) {
          var hasCatch = hasOwn.call(entry, "catchLoc");
          var hasFinally = hasOwn.call(entry, "finallyLoc");

          if (hasCatch && hasFinally) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            } else if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else if (hasCatch) {
            if (this.prev < entry.catchLoc) {
              return handle(entry.catchLoc, true);
            }

          } else if (hasFinally) {
            if (this.prev < entry.finallyLoc) {
              return handle(entry.finallyLoc);
            }

          } else {
            throw new Error("try statement without catch or finally");
          }
        }
      }
    },

    abrupt: function(type, arg) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc <= this.prev &&
            hasOwn.call(entry, "finallyLoc") &&
            this.prev < entry.finallyLoc) {
          var finallyEntry = entry;
          break;
        }
      }

      if (finallyEntry &&
          (type === "break" ||
           type === "continue") &&
          finallyEntry.tryLoc <= arg &&
          arg <= finallyEntry.finallyLoc) {
        // Ignore the finally entry if control is not jumping to a
        // location outside the try/catch block.
        finallyEntry = null;
      }

      var record = finallyEntry ? finallyEntry.completion : {};
      record.type = type;
      record.arg = arg;

      if (finallyEntry) {
        this.method = "next";
        this.next = finallyEntry.finallyLoc;
        return ContinueSentinel;
      }

      return this.complete(record);
    },

    complete: function(record, afterLoc) {
      if (record.type === "throw") {
        throw record.arg;
      }

      if (record.type === "break" ||
          record.type === "continue") {
        this.next = record.arg;
      } else if (record.type === "return") {
        this.rval = this.arg = record.arg;
        this.method = "return";
        this.next = "end";
      } else if (record.type === "normal" && afterLoc) {
        this.next = afterLoc;
      }

      return ContinueSentinel;
    },

    finish: function(finallyLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.finallyLoc === finallyLoc) {
          this.complete(entry.completion, entry.afterLoc);
          resetTryEntry(entry);
          return ContinueSentinel;
        }
      }
    },

    "catch": function(tryLoc) {
      for (var i = this.tryEntries.length - 1; i >= 0; --i) {
        var entry = this.tryEntries[i];
        if (entry.tryLoc === tryLoc) {
          var record = entry.completion;
          if (record.type === "throw") {
            var thrown = record.arg;
            resetTryEntry(entry);
          }
          return thrown;
        }
      }

      // The context.catch method must only be called with a location
      // argument that corresponds to a known catch block.
      throw new Error("illegal catch attempt");
    },

    delegateYield: function(iterable, resultName, nextLoc) {
      this.delegate = {
        iterator: values(iterable),
        resultName: resultName,
        nextLoc: nextLoc
      };

      if (this.method === "next") {
        // Deliberately forget the last sent value so that we don't
        // accidentally pass it on to the delegate.
        this.arg = undefined;
      }

      return ContinueSentinel;
    }
  };

  // Regardless of whether this script is executing as a CommonJS module
  // or not, return the runtime object so that we can declare the variable
  // regeneratorRuntime in the outer scope, which allows this module to be
  // injected easily by `bin/regenerator --include-runtime script.js`.
  return exports;

}(
  // If this script is executing as a CommonJS module, use module.exports
  // as the regeneratorRuntime namespace. Otherwise create a new empty
  // object. Either way, the resulting object will be used to initialize
  // the regeneratorRuntime variable at the top of this file.
  typeof module === "object" ? module.exports : {}
));

try {
  regeneratorRuntime = runtime;
} catch (accidentalStrictMode) {
  // This module should not be running in strict mode, so the above
  // assignment should always work unless something is misconfigured. Just
  // in case runtime.js accidentally runs in strict mode, we can escape
  // strict mode using a global Function call. This could conceivably fail
  // if a Content Security Policy forbids using Function, but in that case
  // the proper solution is to fix the accidental strict mode problem. If
  // you've misconfigured your bundler to force strict mode and applied a
  // CSP to forbid Function, and you're not willing to fix either of those
  // problems, please detail your unique predicament in a GitHub issue.
  Function("r", "regeneratorRuntime = r")(runtime);
}

},{}],2:[function(require,module,exports){
"use strict";

var regeneratorRuntime = require("regenerator-runtime");

var topline = document.querySelector(".menu");
var mobileMenu = document.getElementById("mobileMenu");
var closeBtn = document.getElementById("closeBtn");
var burger = document.getElementById("burger");
var mobileList = document.getElementById("mobileList");
var seeMore = document.getElementById("seeMore");
var counter = 3;
var products = [{
  src: "img/Mask Group.jpg",
  subtitle: "Indoor energy services",
  text: "We helped Indoor energy services to greaty simplify their case management system..."
}, {
  src: "img/Mask Group (1).jpg",
  subtitle: "Birdie Gold Tours",
  text: "We helped Birdy Golf Tours to stay releveant on an inclreasingly competitive market..."
}, {
  src: "img/Mask Group (2).jpg",
  subtitle: "NowWhere",
  text: "We built a recommendations app for people working in creative industries..."
}, {
  src: "img/Mask Group (3).jpg",
  subtitle: "Fyndiqsvajpen",
  text: "We created an app that helped customers find gifts among more than 2900000 items..."
}, {
  src: "img/Mask Group (4).jpg",
  subtitle: "Bythjul",
  text: "We created tire fashion for the increasingly egalitarian car maintinace market..."
}, {
  src: "img/Mask Group (5).jpg",
  subtitle: "Tickin",
  text: "We invented a time reporting system for people who hate time tracking..."
}, {
  src: "img/Mask Group (6).jpg",
  subtitle: "Ubermeds",
  text: "We created an app that helped customers find gifts among more than 2900000 items..."
}, {
  src: "img/Mask Group (7).jpg",
  subtitle: "Västtrafik Calculator",
  text: "We created tire fashion for the increasingly egalitarian car maintinace market..."
}, {
  src: "img/Mask Group (8).jpg",
  subtitle: "Träningspartner",
  text: "We invented a time reporting system for people who hate time tracking..."
}];
document.addEventListener("scroll", function () {
  if (window.pageYOffset < topline.clientHeight) {
    topline.classList.remove("fixed");
  } else {
    topline.classList.add("fixed");
  }
});

burger.onclick = function (e) {
  e.preventDefault();
  mobileMenu.classList.toggle("hide");
};

closeBtn.onclick = function (e) {
  e.preventDefault();
  mobileMenu.classList.toggle("hide");
};

mobileList.onclick = function () {
  mobileMenu.classList.toggle("hide");
};

var renderProducts = function renderProducts(item) {
  return "<div class=\"col-12 col-md-6 col-lg-4\">\n  <div class=\"projects__card\">\n    <img src=\"".concat(item.src, "\" alt=\"mask\">\n    <div class=\"projects__info\">\n      <h4 class=\"projects__subtitle\">").concat(item.subtitle, "</h4>\n      <p class=\"projects__text\">").concat(item.text, "</p>\n    </div>\n  </div>\n</div>");
};

var renderSection = function renderSection(projectsData) {
  var projects = projectsData.map(function (element) {
    return renderProducts(element);
  });
  document.getElementById("projectsRender").innerHTML = projects.join("");
};

seeMore.onclick = function (e) {
  e.preventDefault();
  counter += 3;
  renderSection(products.slice(0, counter));
};

window.addEventListener("DOMContentLoaded", function () {
  var witdhCounter = function witdhCounter() {
    return regeneratorRuntime.async(function witdhCounter$(_context) {
      while (1) {
        switch (_context.prev = _context.next) {
          case 0:
            _context.t0 = true;
            _context.next = _context.t0 === document.documentElement.clientWidth > 768 ? 3 : 5;
            break;

          case 3:
            counter = 9;
            return _context.abrupt("break", 7);

          case 5:
            counter = 3;
            return _context.abrupt("break", 7);

          case 7:
          case "end":
            return _context.stop();
        }
      }
    });
  };

  witdhCounter();
  renderSection(products.slice(0, counter));
});

},{"regenerator-runtime":1}]},{},[2])

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm5vZGVfbW9kdWxlcy9icm93c2VyLXBhY2svX3ByZWx1ZGUuanMiLCJub2RlX21vZHVsZXMvcmVnZW5lcmF0b3ItcnVudGltZS9ydW50aW1lLmpzIiwicHJvamVjdHMvd2hpdGVwb3J0LXNpdGUvc3JjL2pzL2FwcC5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7O0FDdHRCQSxJQUFNLGtCQUFrQixHQUFHLE9BQU8sQ0FBQyxxQkFBRCxDQUFsQzs7QUFFQSxJQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsYUFBVCxDQUF1QixPQUF2QixDQUFoQjtBQUNBLElBQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxjQUFULENBQXdCLFlBQXhCLENBQW5CO0FBQ0EsSUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsVUFBeEIsQ0FBakI7QUFDQSxJQUFNLE1BQU0sR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixRQUF4QixDQUFmO0FBQ0EsSUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsWUFBeEIsQ0FBbkI7QUFDQSxJQUFNLE9BQU8sR0FBRyxRQUFRLENBQUMsY0FBVCxDQUF3QixTQUF4QixDQUFoQjtBQUNBLElBQUksT0FBTyxHQUFHLENBQWQ7QUFDQSxJQUFNLFFBQVEsR0FBRyxDQUNmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsb0JBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSx3QkFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FEZSxFQU9mO0FBQ0UsRUFBQSxHQUFHLEVBQUUsd0JBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSxtQkFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FQZSxFQWFmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsd0JBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSxVQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQWJlLEVBbUJmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsd0JBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSxlQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQW5CZSxFQXlCZjtBQUNFLEVBQUEsR0FBRyxFQUFFLHdCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsU0FGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0F6QmUsRUErQmY7QUFDRSxFQUFBLEdBQUcsRUFBRSx3QkFEUDtBQUVFLEVBQUEsUUFBUSxFQUFFLFFBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBL0JlLEVBcUNmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsd0JBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSxVQUZaO0FBR0UsRUFBQSxJQUFJLEVBQ0Y7QUFKSixDQXJDZSxFQTJDZjtBQUNFLEVBQUEsR0FBRyxFQUFFLHdCQURQO0FBRUUsRUFBQSxRQUFRLEVBQUUsdUJBRlo7QUFHRSxFQUFBLElBQUksRUFDRjtBQUpKLENBM0NlLEVBaURmO0FBQ0UsRUFBQSxHQUFHLEVBQUUsd0JBRFA7QUFFRSxFQUFBLFFBQVEsRUFBRSxpQkFGWjtBQUdFLEVBQUEsSUFBSSxFQUNGO0FBSkosQ0FqRGUsQ0FBakI7QUF5REEsUUFBUSxDQUFDLGdCQUFULENBQTBCLFFBQTFCLEVBQW9DLFlBQU07QUFDeEMsTUFBSSxNQUFNLENBQUMsV0FBUCxHQUFxQixPQUFPLENBQUMsWUFBakMsRUFBK0M7QUFDN0MsSUFBQSxPQUFPLENBQUMsU0FBUixDQUFrQixNQUFsQixDQUF5QixPQUF6QjtBQUNELEdBRkQsTUFFTztBQUNMLElBQUEsT0FBTyxDQUFDLFNBQVIsQ0FBa0IsR0FBbEIsQ0FBc0IsT0FBdEI7QUFDRDtBQUNGLENBTkQ7O0FBUUEsTUFBTSxDQUFDLE9BQVAsR0FBaUIsVUFBQSxDQUFDLEVBQUk7QUFDcEIsRUFBQSxDQUFDLENBQUMsY0FBRjtBQUNBLEVBQUEsVUFBVSxDQUFDLFNBQVgsQ0FBcUIsTUFBckIsQ0FBNEIsTUFBNUI7QUFDRCxDQUhEOztBQUtBLFFBQVEsQ0FBQyxPQUFULEdBQW1CLFVBQUEsQ0FBQyxFQUFJO0FBQ3RCLEVBQUEsQ0FBQyxDQUFDLGNBQUY7QUFDQSxFQUFBLFVBQVUsQ0FBQyxTQUFYLENBQXFCLE1BQXJCLENBQTRCLE1BQTVCO0FBQ0QsQ0FIRDs7QUFLQSxVQUFVLENBQUMsT0FBWCxHQUFxQixZQUFNO0FBQ3pCLEVBQUEsVUFBVSxDQUFDLFNBQVgsQ0FBcUIsTUFBckIsQ0FBNEIsTUFBNUI7QUFDRCxDQUZEOztBQU1BLElBQU0sY0FBYyxHQUFHLFNBQWpCLGNBQWlCLENBQUEsSUFBSSxFQUFJO0FBQzdCLDhHQUVjLElBQUksQ0FBQyxHQUZuQiwwR0FJcUMsSUFBSSxDQUFDLFFBSjFDLHNEQUtnQyxJQUFJLENBQUMsSUFMckM7QUFTRCxDQVZEOztBQVlBLElBQUksYUFBYSxHQUFHLFNBQWhCLGFBQWdCLENBQUEsWUFBWSxFQUFJO0FBQ2xDLE1BQU0sUUFBUSxHQUFJLFlBQVksQ0FBQyxHQUFiLENBQWlCLFVBQUEsT0FBTztBQUFBLFdBQUksY0FBYyxDQUFDLE9BQUQsQ0FBbEI7QUFBQSxHQUF4QixDQUFsQjtBQUNBLEVBQUEsUUFBUSxDQUFDLGNBQVQsQ0FBd0IsZ0JBQXhCLEVBQTBDLFNBQTFDLEdBQXNELFFBQVEsQ0FBQyxJQUFULENBQWMsRUFBZCxDQUF0RDtBQUNELENBSEQ7O0FBS0EsT0FBTyxDQUFDLE9BQVIsR0FBa0IsVUFBQSxDQUFDLEVBQUk7QUFDckIsRUFBQSxDQUFDLENBQUMsY0FBRjtBQUNBLEVBQUEsT0FBTyxJQUFJLENBQVg7QUFDQSxFQUFBLGFBQWEsQ0FBQyxRQUFRLENBQUMsS0FBVCxDQUFlLENBQWYsRUFBa0IsT0FBbEIsQ0FBRCxDQUFiO0FBQ0QsQ0FKRDs7QUFNQSxNQUFNLENBQUMsZ0JBQVAsQ0FBd0Isa0JBQXhCLEVBQTRDLFlBQU07QUFDaEQsTUFBTSxZQUFZLEdBQUcsU0FBZixZQUFlO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSwwQkFDWCxJQURXO0FBQUEsNENBRVosUUFBUSxDQUFDLGVBQVQsQ0FBeUIsV0FBekIsR0FBdUMsR0FGM0I7QUFBQTs7QUFBQTtBQUdmLFlBQUEsT0FBTyxHQUFHLENBQVY7QUFIZTs7QUFBQTtBQU1mLFlBQUEsT0FBTyxHQUFHLENBQVY7QUFOZTs7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxHQUFyQjs7QUFVQSxFQUFBLFlBQVk7QUFDWixFQUFBLGFBQWEsQ0FBQyxRQUFRLENBQUMsS0FBVCxDQUFlLENBQWYsRUFBa0IsT0FBbEIsQ0FBRCxDQUFiO0FBQ0QsQ0FiRCIsImZpbGUiOiJidW5kbGUuanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKXtmdW5jdGlvbiByKGUsbix0KXtmdW5jdGlvbiBvKGksZil7aWYoIW5baV0pe2lmKCFlW2ldKXt2YXIgYz1cImZ1bmN0aW9uXCI9PXR5cGVvZiByZXF1aXJlJiZyZXF1aXJlO2lmKCFmJiZjKXJldHVybiBjKGksITApO2lmKHUpcmV0dXJuIHUoaSwhMCk7dmFyIGE9bmV3IEVycm9yKFwiQ2Fubm90IGZpbmQgbW9kdWxlICdcIitpK1wiJ1wiKTt0aHJvdyBhLmNvZGU9XCJNT0RVTEVfTk9UX0ZPVU5EXCIsYX12YXIgcD1uW2ldPXtleHBvcnRzOnt9fTtlW2ldWzBdLmNhbGwocC5leHBvcnRzLGZ1bmN0aW9uKHIpe3ZhciBuPWVbaV1bMV1bcl07cmV0dXJuIG8obnx8cil9LHAscC5leHBvcnRzLHIsZSxuLHQpfXJldHVybiBuW2ldLmV4cG9ydHN9Zm9yKHZhciB1PVwiZnVuY3Rpb25cIj09dHlwZW9mIHJlcXVpcmUmJnJlcXVpcmUsaT0wO2k8dC5sZW5ndGg7aSsrKW8odFtpXSk7cmV0dXJuIG99cmV0dXJuIHJ9KSgpIiwiLyoqXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQtcHJlc2VudCwgRmFjZWJvb2ssIEluYy5cbiAqXG4gKiBUaGlzIHNvdXJjZSBjb2RlIGlzIGxpY2Vuc2VkIHVuZGVyIHRoZSBNSVQgbGljZW5zZSBmb3VuZCBpbiB0aGVcbiAqIExJQ0VOU0UgZmlsZSBpbiB0aGUgcm9vdCBkaXJlY3Rvcnkgb2YgdGhpcyBzb3VyY2UgdHJlZS5cbiAqL1xuXG52YXIgcnVudGltZSA9IChmdW5jdGlvbiAoZXhwb3J0cykge1xuICBcInVzZSBzdHJpY3RcIjtcblxuICB2YXIgT3AgPSBPYmplY3QucHJvdG90eXBlO1xuICB2YXIgaGFzT3duID0gT3AuaGFzT3duUHJvcGVydHk7XG4gIHZhciB1bmRlZmluZWQ7IC8vIE1vcmUgY29tcHJlc3NpYmxlIHRoYW4gdm9pZCAwLlxuICB2YXIgJFN5bWJvbCA9IHR5cGVvZiBTeW1ib2wgPT09IFwiZnVuY3Rpb25cIiA/IFN5bWJvbCA6IHt9O1xuICB2YXIgaXRlcmF0b3JTeW1ib2wgPSAkU3ltYm9sLml0ZXJhdG9yIHx8IFwiQEBpdGVyYXRvclwiO1xuICB2YXIgYXN5bmNJdGVyYXRvclN5bWJvbCA9ICRTeW1ib2wuYXN5bmNJdGVyYXRvciB8fCBcIkBAYXN5bmNJdGVyYXRvclwiO1xuICB2YXIgdG9TdHJpbmdUYWdTeW1ib2wgPSAkU3ltYm9sLnRvU3RyaW5nVGFnIHx8IFwiQEB0b1N0cmluZ1RhZ1wiO1xuXG4gIGZ1bmN0aW9uIHdyYXAoaW5uZXJGbiwgb3V0ZXJGbiwgc2VsZiwgdHJ5TG9jc0xpc3QpIHtcbiAgICAvLyBJZiBvdXRlckZuIHByb3ZpZGVkIGFuZCBvdXRlckZuLnByb3RvdHlwZSBpcyBhIEdlbmVyYXRvciwgdGhlbiBvdXRlckZuLnByb3RvdHlwZSBpbnN0YW5jZW9mIEdlbmVyYXRvci5cbiAgICB2YXIgcHJvdG9HZW5lcmF0b3IgPSBvdXRlckZuICYmIG91dGVyRm4ucHJvdG90eXBlIGluc3RhbmNlb2YgR2VuZXJhdG9yID8gb3V0ZXJGbiA6IEdlbmVyYXRvcjtcbiAgICB2YXIgZ2VuZXJhdG9yID0gT2JqZWN0LmNyZWF0ZShwcm90b0dlbmVyYXRvci5wcm90b3R5cGUpO1xuICAgIHZhciBjb250ZXh0ID0gbmV3IENvbnRleHQodHJ5TG9jc0xpc3QgfHwgW10pO1xuXG4gICAgLy8gVGhlIC5faW52b2tlIG1ldGhvZCB1bmlmaWVzIHRoZSBpbXBsZW1lbnRhdGlvbnMgb2YgdGhlIC5uZXh0LFxuICAgIC8vIC50aHJvdywgYW5kIC5yZXR1cm4gbWV0aG9kcy5cbiAgICBnZW5lcmF0b3IuX2ludm9rZSA9IG1ha2VJbnZva2VNZXRob2QoaW5uZXJGbiwgc2VsZiwgY29udGV4dCk7XG5cbiAgICByZXR1cm4gZ2VuZXJhdG9yO1xuICB9XG4gIGV4cG9ydHMud3JhcCA9IHdyYXA7XG5cbiAgLy8gVHJ5L2NhdGNoIGhlbHBlciB0byBtaW5pbWl6ZSBkZW9wdGltaXphdGlvbnMuIFJldHVybnMgYSBjb21wbGV0aW9uXG4gIC8vIHJlY29yZCBsaWtlIGNvbnRleHQudHJ5RW50cmllc1tpXS5jb21wbGV0aW9uLiBUaGlzIGludGVyZmFjZSBjb3VsZFxuICAvLyBoYXZlIGJlZW4gKGFuZCB3YXMgcHJldmlvdXNseSkgZGVzaWduZWQgdG8gdGFrZSBhIGNsb3N1cmUgdG8gYmVcbiAgLy8gaW52b2tlZCB3aXRob3V0IGFyZ3VtZW50cywgYnV0IGluIGFsbCB0aGUgY2FzZXMgd2UgY2FyZSBhYm91dCB3ZVxuICAvLyBhbHJlYWR5IGhhdmUgYW4gZXhpc3RpbmcgbWV0aG9kIHdlIHdhbnQgdG8gY2FsbCwgc28gdGhlcmUncyBubyBuZWVkXG4gIC8vIHRvIGNyZWF0ZSBhIG5ldyBmdW5jdGlvbiBvYmplY3QuIFdlIGNhbiBldmVuIGdldCBhd2F5IHdpdGggYXNzdW1pbmdcbiAgLy8gdGhlIG1ldGhvZCB0YWtlcyBleGFjdGx5IG9uZSBhcmd1bWVudCwgc2luY2UgdGhhdCBoYXBwZW5zIHRvIGJlIHRydWVcbiAgLy8gaW4gZXZlcnkgY2FzZSwgc28gd2UgZG9uJ3QgaGF2ZSB0byB0b3VjaCB0aGUgYXJndW1lbnRzIG9iamVjdC4gVGhlXG4gIC8vIG9ubHkgYWRkaXRpb25hbCBhbGxvY2F0aW9uIHJlcXVpcmVkIGlzIHRoZSBjb21wbGV0aW9uIHJlY29yZCwgd2hpY2hcbiAgLy8gaGFzIGEgc3RhYmxlIHNoYXBlIGFuZCBzbyBob3BlZnVsbHkgc2hvdWxkIGJlIGNoZWFwIHRvIGFsbG9jYXRlLlxuICBmdW5jdGlvbiB0cnlDYXRjaChmbiwgb2JqLCBhcmcpIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIHsgdHlwZTogXCJub3JtYWxcIiwgYXJnOiBmbi5jYWxsKG9iaiwgYXJnKSB9O1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgcmV0dXJuIHsgdHlwZTogXCJ0aHJvd1wiLCBhcmc6IGVyciB9O1xuICAgIH1cbiAgfVxuXG4gIHZhciBHZW5TdGF0ZVN1c3BlbmRlZFN0YXJ0ID0gXCJzdXNwZW5kZWRTdGFydFwiO1xuICB2YXIgR2VuU3RhdGVTdXNwZW5kZWRZaWVsZCA9IFwic3VzcGVuZGVkWWllbGRcIjtcbiAgdmFyIEdlblN0YXRlRXhlY3V0aW5nID0gXCJleGVjdXRpbmdcIjtcbiAgdmFyIEdlblN0YXRlQ29tcGxldGVkID0gXCJjb21wbGV0ZWRcIjtcblxuICAvLyBSZXR1cm5pbmcgdGhpcyBvYmplY3QgZnJvbSB0aGUgaW5uZXJGbiBoYXMgdGhlIHNhbWUgZWZmZWN0IGFzXG4gIC8vIGJyZWFraW5nIG91dCBvZiB0aGUgZGlzcGF0Y2ggc3dpdGNoIHN0YXRlbWVudC5cbiAgdmFyIENvbnRpbnVlU2VudGluZWwgPSB7fTtcblxuICAvLyBEdW1teSBjb25zdHJ1Y3RvciBmdW5jdGlvbnMgdGhhdCB3ZSB1c2UgYXMgdGhlIC5jb25zdHJ1Y3RvciBhbmRcbiAgLy8gLmNvbnN0cnVjdG9yLnByb3RvdHlwZSBwcm9wZXJ0aWVzIGZvciBmdW5jdGlvbnMgdGhhdCByZXR1cm4gR2VuZXJhdG9yXG4gIC8vIG9iamVjdHMuIEZvciBmdWxsIHNwZWMgY29tcGxpYW5jZSwgeW91IG1heSB3aXNoIHRvIGNvbmZpZ3VyZSB5b3VyXG4gIC8vIG1pbmlmaWVyIG5vdCB0byBtYW5nbGUgdGhlIG5hbWVzIG9mIHRoZXNlIHR3byBmdW5jdGlvbnMuXG4gIGZ1bmN0aW9uIEdlbmVyYXRvcigpIHt9XG4gIGZ1bmN0aW9uIEdlbmVyYXRvckZ1bmN0aW9uKCkge31cbiAgZnVuY3Rpb24gR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGUoKSB7fVxuXG4gIC8vIFRoaXMgaXMgYSBwb2x5ZmlsbCBmb3IgJUl0ZXJhdG9yUHJvdG90eXBlJSBmb3IgZW52aXJvbm1lbnRzIHRoYXRcbiAgLy8gZG9uJ3QgbmF0aXZlbHkgc3VwcG9ydCBpdC5cbiAgdmFyIEl0ZXJhdG9yUHJvdG90eXBlID0ge307XG4gIEl0ZXJhdG9yUHJvdG90eXBlW2l0ZXJhdG9yU3ltYm9sXSA9IGZ1bmN0aW9uICgpIHtcbiAgICByZXR1cm4gdGhpcztcbiAgfTtcblxuICB2YXIgZ2V0UHJvdG8gPSBPYmplY3QuZ2V0UHJvdG90eXBlT2Y7XG4gIHZhciBOYXRpdmVJdGVyYXRvclByb3RvdHlwZSA9IGdldFByb3RvICYmIGdldFByb3RvKGdldFByb3RvKHZhbHVlcyhbXSkpKTtcbiAgaWYgKE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlICYmXG4gICAgICBOYXRpdmVJdGVyYXRvclByb3RvdHlwZSAhPT0gT3AgJiZcbiAgICAgIGhhc093bi5jYWxsKE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlLCBpdGVyYXRvclN5bWJvbCkpIHtcbiAgICAvLyBUaGlzIGVudmlyb25tZW50IGhhcyBhIG5hdGl2ZSAlSXRlcmF0b3JQcm90b3R5cGUlOyB1c2UgaXQgaW5zdGVhZFxuICAgIC8vIG9mIHRoZSBwb2x5ZmlsbC5cbiAgICBJdGVyYXRvclByb3RvdHlwZSA9IE5hdGl2ZUl0ZXJhdG9yUHJvdG90eXBlO1xuICB9XG5cbiAgdmFyIEdwID0gR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGUucHJvdG90eXBlID1cbiAgICBHZW5lcmF0b3IucHJvdG90eXBlID0gT2JqZWN0LmNyZWF0ZShJdGVyYXRvclByb3RvdHlwZSk7XG4gIEdlbmVyYXRvckZ1bmN0aW9uLnByb3RvdHlwZSA9IEdwLmNvbnN0cnVjdG9yID0gR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGU7XG4gIEdlbmVyYXRvckZ1bmN0aW9uUHJvdG90eXBlLmNvbnN0cnVjdG9yID0gR2VuZXJhdG9yRnVuY3Rpb247XG4gIEdlbmVyYXRvckZ1bmN0aW9uUHJvdG90eXBlW3RvU3RyaW5nVGFnU3ltYm9sXSA9XG4gICAgR2VuZXJhdG9yRnVuY3Rpb24uZGlzcGxheU5hbWUgPSBcIkdlbmVyYXRvckZ1bmN0aW9uXCI7XG5cbiAgLy8gSGVscGVyIGZvciBkZWZpbmluZyB0aGUgLm5leHQsIC50aHJvdywgYW5kIC5yZXR1cm4gbWV0aG9kcyBvZiB0aGVcbiAgLy8gSXRlcmF0b3IgaW50ZXJmYWNlIGluIHRlcm1zIG9mIGEgc2luZ2xlIC5faW52b2tlIG1ldGhvZC5cbiAgZnVuY3Rpb24gZGVmaW5lSXRlcmF0b3JNZXRob2RzKHByb3RvdHlwZSkge1xuICAgIFtcIm5leHRcIiwgXCJ0aHJvd1wiLCBcInJldHVyblwiXS5mb3JFYWNoKGZ1bmN0aW9uKG1ldGhvZCkge1xuICAgICAgcHJvdG90eXBlW21ldGhvZF0gPSBmdW5jdGlvbihhcmcpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2ludm9rZShtZXRob2QsIGFyZyk7XG4gICAgICB9O1xuICAgIH0pO1xuICB9XG5cbiAgZXhwb3J0cy5pc0dlbmVyYXRvckZ1bmN0aW9uID0gZnVuY3Rpb24oZ2VuRnVuKSB7XG4gICAgdmFyIGN0b3IgPSB0eXBlb2YgZ2VuRnVuID09PSBcImZ1bmN0aW9uXCIgJiYgZ2VuRnVuLmNvbnN0cnVjdG9yO1xuICAgIHJldHVybiBjdG9yXG4gICAgICA/IGN0b3IgPT09IEdlbmVyYXRvckZ1bmN0aW9uIHx8XG4gICAgICAgIC8vIEZvciB0aGUgbmF0aXZlIEdlbmVyYXRvckZ1bmN0aW9uIGNvbnN0cnVjdG9yLCB0aGUgYmVzdCB3ZSBjYW5cbiAgICAgICAgLy8gZG8gaXMgdG8gY2hlY2sgaXRzIC5uYW1lIHByb3BlcnR5LlxuICAgICAgICAoY3Rvci5kaXNwbGF5TmFtZSB8fCBjdG9yLm5hbWUpID09PSBcIkdlbmVyYXRvckZ1bmN0aW9uXCJcbiAgICAgIDogZmFsc2U7XG4gIH07XG5cbiAgZXhwb3J0cy5tYXJrID0gZnVuY3Rpb24oZ2VuRnVuKSB7XG4gICAgaWYgKE9iamVjdC5zZXRQcm90b3R5cGVPZikge1xuICAgICAgT2JqZWN0LnNldFByb3RvdHlwZU9mKGdlbkZ1biwgR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGUpO1xuICAgIH0gZWxzZSB7XG4gICAgICBnZW5GdW4uX19wcm90b19fID0gR2VuZXJhdG9yRnVuY3Rpb25Qcm90b3R5cGU7XG4gICAgICBpZiAoISh0b1N0cmluZ1RhZ1N5bWJvbCBpbiBnZW5GdW4pKSB7XG4gICAgICAgIGdlbkZ1blt0b1N0cmluZ1RhZ1N5bWJvbF0gPSBcIkdlbmVyYXRvckZ1bmN0aW9uXCI7XG4gICAgICB9XG4gICAgfVxuICAgIGdlbkZ1bi5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKEdwKTtcbiAgICByZXR1cm4gZ2VuRnVuO1xuICB9O1xuXG4gIC8vIFdpdGhpbiB0aGUgYm9keSBvZiBhbnkgYXN5bmMgZnVuY3Rpb24sIGBhd2FpdCB4YCBpcyB0cmFuc2Zvcm1lZCB0b1xuICAvLyBgeWllbGQgcmVnZW5lcmF0b3JSdW50aW1lLmF3cmFwKHgpYCwgc28gdGhhdCB0aGUgcnVudGltZSBjYW4gdGVzdFxuICAvLyBgaGFzT3duLmNhbGwodmFsdWUsIFwiX19hd2FpdFwiKWAgdG8gZGV0ZXJtaW5lIGlmIHRoZSB5aWVsZGVkIHZhbHVlIGlzXG4gIC8vIG1lYW50IHRvIGJlIGF3YWl0ZWQuXG4gIGV4cG9ydHMuYXdyYXAgPSBmdW5jdGlvbihhcmcpIHtcbiAgICByZXR1cm4geyBfX2F3YWl0OiBhcmcgfTtcbiAgfTtcblxuICBmdW5jdGlvbiBBc3luY0l0ZXJhdG9yKGdlbmVyYXRvcikge1xuICAgIGZ1bmN0aW9uIGludm9rZShtZXRob2QsIGFyZywgcmVzb2x2ZSwgcmVqZWN0KSB7XG4gICAgICB2YXIgcmVjb3JkID0gdHJ5Q2F0Y2goZ2VuZXJhdG9yW21ldGhvZF0sIGdlbmVyYXRvciwgYXJnKTtcbiAgICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgIHJlamVjdChyZWNvcmQuYXJnKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciByZXN1bHQgPSByZWNvcmQuYXJnO1xuICAgICAgICB2YXIgdmFsdWUgPSByZXN1bHQudmFsdWU7XG4gICAgICAgIGlmICh2YWx1ZSAmJlxuICAgICAgICAgICAgdHlwZW9mIHZhbHVlID09PSBcIm9iamVjdFwiICYmXG4gICAgICAgICAgICBoYXNPd24uY2FsbCh2YWx1ZSwgXCJfX2F3YWl0XCIpKSB7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh2YWx1ZS5fX2F3YWl0KS50aGVuKGZ1bmN0aW9uKHZhbHVlKSB7XG4gICAgICAgICAgICBpbnZva2UoXCJuZXh0XCIsIHZhbHVlLCByZXNvbHZlLCByZWplY3QpO1xuICAgICAgICAgIH0sIGZ1bmN0aW9uKGVycikge1xuICAgICAgICAgICAgaW52b2tlKFwidGhyb3dcIiwgZXJyLCByZXNvbHZlLCByZWplY3QpO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh2YWx1ZSkudGhlbihmdW5jdGlvbih1bndyYXBwZWQpIHtcbiAgICAgICAgICAvLyBXaGVuIGEgeWllbGRlZCBQcm9taXNlIGlzIHJlc29sdmVkLCBpdHMgZmluYWwgdmFsdWUgYmVjb21lc1xuICAgICAgICAgIC8vIHRoZSAudmFsdWUgb2YgdGhlIFByb21pc2U8e3ZhbHVlLGRvbmV9PiByZXN1bHQgZm9yIHRoZVxuICAgICAgICAgIC8vIGN1cnJlbnQgaXRlcmF0aW9uLlxuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHVud3JhcHBlZDtcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgIH0sIGZ1bmN0aW9uKGVycm9yKSB7XG4gICAgICAgICAgLy8gSWYgYSByZWplY3RlZCBQcm9taXNlIHdhcyB5aWVsZGVkLCB0aHJvdyB0aGUgcmVqZWN0aW9uIGJhY2tcbiAgICAgICAgICAvLyBpbnRvIHRoZSBhc3luYyBnZW5lcmF0b3IgZnVuY3Rpb24gc28gaXQgY2FuIGJlIGhhbmRsZWQgdGhlcmUuXG4gICAgICAgICAgcmV0dXJuIGludm9rZShcInRocm93XCIsIGVycm9yLCByZXNvbHZlLCByZWplY3QpO1xuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICB2YXIgcHJldmlvdXNQcm9taXNlO1xuXG4gICAgZnVuY3Rpb24gZW5xdWV1ZShtZXRob2QsIGFyZykge1xuICAgICAgZnVuY3Rpb24gY2FsbEludm9rZVdpdGhNZXRob2RBbmRBcmcoKSB7XG4gICAgICAgIHJldHVybiBuZXcgUHJvbWlzZShmdW5jdGlvbihyZXNvbHZlLCByZWplY3QpIHtcbiAgICAgICAgICBpbnZva2UobWV0aG9kLCBhcmcsIHJlc29sdmUsIHJlamVjdCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gcHJldmlvdXNQcm9taXNlID1cbiAgICAgICAgLy8gSWYgZW5xdWV1ZSBoYXMgYmVlbiBjYWxsZWQgYmVmb3JlLCB0aGVuIHdlIHdhbnQgdG8gd2FpdCB1bnRpbFxuICAgICAgICAvLyBhbGwgcHJldmlvdXMgUHJvbWlzZXMgaGF2ZSBiZWVuIHJlc29sdmVkIGJlZm9yZSBjYWxsaW5nIGludm9rZSxcbiAgICAgICAgLy8gc28gdGhhdCByZXN1bHRzIGFyZSBhbHdheXMgZGVsaXZlcmVkIGluIHRoZSBjb3JyZWN0IG9yZGVyLiBJZlxuICAgICAgICAvLyBlbnF1ZXVlIGhhcyBub3QgYmVlbiBjYWxsZWQgYmVmb3JlLCB0aGVuIGl0IGlzIGltcG9ydGFudCB0b1xuICAgICAgICAvLyBjYWxsIGludm9rZSBpbW1lZGlhdGVseSwgd2l0aG91dCB3YWl0aW5nIG9uIGEgY2FsbGJhY2sgdG8gZmlyZSxcbiAgICAgICAgLy8gc28gdGhhdCB0aGUgYXN5bmMgZ2VuZXJhdG9yIGZ1bmN0aW9uIGhhcyB0aGUgb3Bwb3J0dW5pdHkgdG8gZG9cbiAgICAgICAgLy8gYW55IG5lY2Vzc2FyeSBzZXR1cCBpbiBhIHByZWRpY3RhYmxlIHdheS4gVGhpcyBwcmVkaWN0YWJpbGl0eVxuICAgICAgICAvLyBpcyB3aHkgdGhlIFByb21pc2UgY29uc3RydWN0b3Igc3luY2hyb25vdXNseSBpbnZva2VzIGl0c1xuICAgICAgICAvLyBleGVjdXRvciBjYWxsYmFjaywgYW5kIHdoeSBhc3luYyBmdW5jdGlvbnMgc3luY2hyb25vdXNseVxuICAgICAgICAvLyBleGVjdXRlIGNvZGUgYmVmb3JlIHRoZSBmaXJzdCBhd2FpdC4gU2luY2Ugd2UgaW1wbGVtZW50IHNpbXBsZVxuICAgICAgICAvLyBhc3luYyBmdW5jdGlvbnMgaW4gdGVybXMgb2YgYXN5bmMgZ2VuZXJhdG9ycywgaXQgaXMgZXNwZWNpYWxseVxuICAgICAgICAvLyBpbXBvcnRhbnQgdG8gZ2V0IHRoaXMgcmlnaHQsIGV2ZW4gdGhvdWdoIGl0IHJlcXVpcmVzIGNhcmUuXG4gICAgICAgIHByZXZpb3VzUHJvbWlzZSA/IHByZXZpb3VzUHJvbWlzZS50aGVuKFxuICAgICAgICAgIGNhbGxJbnZva2VXaXRoTWV0aG9kQW5kQXJnLFxuICAgICAgICAgIC8vIEF2b2lkIHByb3BhZ2F0aW5nIGZhaWx1cmVzIHRvIFByb21pc2VzIHJldHVybmVkIGJ5IGxhdGVyXG4gICAgICAgICAgLy8gaW52b2NhdGlvbnMgb2YgdGhlIGl0ZXJhdG9yLlxuICAgICAgICAgIGNhbGxJbnZva2VXaXRoTWV0aG9kQW5kQXJnXG4gICAgICAgICkgOiBjYWxsSW52b2tlV2l0aE1ldGhvZEFuZEFyZygpO1xuICAgIH1cblxuICAgIC8vIERlZmluZSB0aGUgdW5pZmllZCBoZWxwZXIgbWV0aG9kIHRoYXQgaXMgdXNlZCB0byBpbXBsZW1lbnQgLm5leHQsXG4gICAgLy8gLnRocm93LCBhbmQgLnJldHVybiAoc2VlIGRlZmluZUl0ZXJhdG9yTWV0aG9kcykuXG4gICAgdGhpcy5faW52b2tlID0gZW5xdWV1ZTtcbiAgfVxuXG4gIGRlZmluZUl0ZXJhdG9yTWV0aG9kcyhBc3luY0l0ZXJhdG9yLnByb3RvdHlwZSk7XG4gIEFzeW5jSXRlcmF0b3IucHJvdG90eXBlW2FzeW5jSXRlcmF0b3JTeW1ib2xdID0gZnVuY3Rpb24gKCkge1xuICAgIHJldHVybiB0aGlzO1xuICB9O1xuICBleHBvcnRzLkFzeW5jSXRlcmF0b3IgPSBBc3luY0l0ZXJhdG9yO1xuXG4gIC8vIE5vdGUgdGhhdCBzaW1wbGUgYXN5bmMgZnVuY3Rpb25zIGFyZSBpbXBsZW1lbnRlZCBvbiB0b3Agb2ZcbiAgLy8gQXN5bmNJdGVyYXRvciBvYmplY3RzOyB0aGV5IGp1c3QgcmV0dXJuIGEgUHJvbWlzZSBmb3IgdGhlIHZhbHVlIG9mXG4gIC8vIHRoZSBmaW5hbCByZXN1bHQgcHJvZHVjZWQgYnkgdGhlIGl0ZXJhdG9yLlxuICBleHBvcnRzLmFzeW5jID0gZnVuY3Rpb24oaW5uZXJGbiwgb3V0ZXJGbiwgc2VsZiwgdHJ5TG9jc0xpc3QpIHtcbiAgICB2YXIgaXRlciA9IG5ldyBBc3luY0l0ZXJhdG9yKFxuICAgICAgd3JhcChpbm5lckZuLCBvdXRlckZuLCBzZWxmLCB0cnlMb2NzTGlzdClcbiAgICApO1xuXG4gICAgcmV0dXJuIGV4cG9ydHMuaXNHZW5lcmF0b3JGdW5jdGlvbihvdXRlckZuKVxuICAgICAgPyBpdGVyIC8vIElmIG91dGVyRm4gaXMgYSBnZW5lcmF0b3IsIHJldHVybiB0aGUgZnVsbCBpdGVyYXRvci5cbiAgICAgIDogaXRlci5uZXh0KCkudGhlbihmdW5jdGlvbihyZXN1bHQpIHtcbiAgICAgICAgICByZXR1cm4gcmVzdWx0LmRvbmUgPyByZXN1bHQudmFsdWUgOiBpdGVyLm5leHQoKTtcbiAgICAgICAgfSk7XG4gIH07XG5cbiAgZnVuY3Rpb24gbWFrZUludm9rZU1ldGhvZChpbm5lckZuLCBzZWxmLCBjb250ZXh0KSB7XG4gICAgdmFyIHN0YXRlID0gR2VuU3RhdGVTdXNwZW5kZWRTdGFydDtcblxuICAgIHJldHVybiBmdW5jdGlvbiBpbnZva2UobWV0aG9kLCBhcmcpIHtcbiAgICAgIGlmIChzdGF0ZSA9PT0gR2VuU3RhdGVFeGVjdXRpbmcpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiR2VuZXJhdG9yIGlzIGFscmVhZHkgcnVubmluZ1wiKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHN0YXRlID09PSBHZW5TdGF0ZUNvbXBsZXRlZCkge1xuICAgICAgICBpZiAobWV0aG9kID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICB0aHJvdyBhcmc7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBCZSBmb3JnaXZpbmcsIHBlciAyNS4zLjMuMy4zIG9mIHRoZSBzcGVjOlxuICAgICAgICAvLyBodHRwczovL3Blb3BsZS5tb3ppbGxhLm9yZy9+am9yZW5kb3JmZi9lczYtZHJhZnQuaHRtbCNzZWMtZ2VuZXJhdG9ycmVzdW1lXG4gICAgICAgIHJldHVybiBkb25lUmVzdWx0KCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnRleHQubWV0aG9kID0gbWV0aG9kO1xuICAgICAgY29udGV4dC5hcmcgPSBhcmc7XG5cbiAgICAgIHdoaWxlICh0cnVlKSB7XG4gICAgICAgIHZhciBkZWxlZ2F0ZSA9IGNvbnRleHQuZGVsZWdhdGU7XG4gICAgICAgIGlmIChkZWxlZ2F0ZSkge1xuICAgICAgICAgIHZhciBkZWxlZ2F0ZVJlc3VsdCA9IG1heWJlSW52b2tlRGVsZWdhdGUoZGVsZWdhdGUsIGNvbnRleHQpO1xuICAgICAgICAgIGlmIChkZWxlZ2F0ZVJlc3VsdCkge1xuICAgICAgICAgICAgaWYgKGRlbGVnYXRlUmVzdWx0ID09PSBDb250aW51ZVNlbnRpbmVsKSBjb250aW51ZTtcbiAgICAgICAgICAgIHJldHVybiBkZWxlZ2F0ZVJlc3VsdDtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5tZXRob2QgPT09IFwibmV4dFwiKSB7XG4gICAgICAgICAgLy8gU2V0dGluZyBjb250ZXh0Ll9zZW50IGZvciBsZWdhY3kgc3VwcG9ydCBvZiBCYWJlbCdzXG4gICAgICAgICAgLy8gZnVuY3Rpb24uc2VudCBpbXBsZW1lbnRhdGlvbi5cbiAgICAgICAgICBjb250ZXh0LnNlbnQgPSBjb250ZXh0Ll9zZW50ID0gY29udGV4dC5hcmc7XG5cbiAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm1ldGhvZCA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgICAgaWYgKHN0YXRlID09PSBHZW5TdGF0ZVN1c3BlbmRlZFN0YXJ0KSB7XG4gICAgICAgICAgICBzdGF0ZSA9IEdlblN0YXRlQ29tcGxldGVkO1xuICAgICAgICAgICAgdGhyb3cgY29udGV4dC5hcmc7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29udGV4dC5kaXNwYXRjaEV4Y2VwdGlvbihjb250ZXh0LmFyZyk7XG5cbiAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm1ldGhvZCA9PT0gXCJyZXR1cm5cIikge1xuICAgICAgICAgIGNvbnRleHQuYWJydXB0KFwicmV0dXJuXCIsIGNvbnRleHQuYXJnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN0YXRlID0gR2VuU3RhdGVFeGVjdXRpbmc7XG5cbiAgICAgICAgdmFyIHJlY29yZCA9IHRyeUNhdGNoKGlubmVyRm4sIHNlbGYsIGNvbnRleHQpO1xuICAgICAgICBpZiAocmVjb3JkLnR5cGUgPT09IFwibm9ybWFsXCIpIHtcbiAgICAgICAgICAvLyBJZiBhbiBleGNlcHRpb24gaXMgdGhyb3duIGZyb20gaW5uZXJGbiwgd2UgbGVhdmUgc3RhdGUgPT09XG4gICAgICAgICAgLy8gR2VuU3RhdGVFeGVjdXRpbmcgYW5kIGxvb3AgYmFjayBmb3IgYW5vdGhlciBpbnZvY2F0aW9uLlxuICAgICAgICAgIHN0YXRlID0gY29udGV4dC5kb25lXG4gICAgICAgICAgICA/IEdlblN0YXRlQ29tcGxldGVkXG4gICAgICAgICAgICA6IEdlblN0YXRlU3VzcGVuZGVkWWllbGQ7XG5cbiAgICAgICAgICBpZiAocmVjb3JkLmFyZyA9PT0gQ29udGludWVTZW50aW5lbCkge1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIHZhbHVlOiByZWNvcmQuYXJnLFxuICAgICAgICAgICAgZG9uZTogY29udGV4dC5kb25lXG4gICAgICAgICAgfTtcblxuICAgICAgICB9IGVsc2UgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICBzdGF0ZSA9IEdlblN0YXRlQ29tcGxldGVkO1xuICAgICAgICAgIC8vIERpc3BhdGNoIHRoZSBleGNlcHRpb24gYnkgbG9vcGluZyBiYWNrIGFyb3VuZCB0byB0aGVcbiAgICAgICAgICAvLyBjb250ZXh0LmRpc3BhdGNoRXhjZXB0aW9uKGNvbnRleHQuYXJnKSBjYWxsIGFib3ZlLlxuICAgICAgICAgIGNvbnRleHQubWV0aG9kID0gXCJ0aHJvd1wiO1xuICAgICAgICAgIGNvbnRleHQuYXJnID0gcmVjb3JkLmFyZztcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH07XG4gIH1cblxuICAvLyBDYWxsIGRlbGVnYXRlLml0ZXJhdG9yW2NvbnRleHQubWV0aG9kXShjb250ZXh0LmFyZykgYW5kIGhhbmRsZSB0aGVcbiAgLy8gcmVzdWx0LCBlaXRoZXIgYnkgcmV0dXJuaW5nIGEgeyB2YWx1ZSwgZG9uZSB9IHJlc3VsdCBmcm9tIHRoZVxuICAvLyBkZWxlZ2F0ZSBpdGVyYXRvciwgb3IgYnkgbW9kaWZ5aW5nIGNvbnRleHQubWV0aG9kIGFuZCBjb250ZXh0LmFyZyxcbiAgLy8gc2V0dGluZyBjb250ZXh0LmRlbGVnYXRlIHRvIG51bGwsIGFuZCByZXR1cm5pbmcgdGhlIENvbnRpbnVlU2VudGluZWwuXG4gIGZ1bmN0aW9uIG1heWJlSW52b2tlRGVsZWdhdGUoZGVsZWdhdGUsIGNvbnRleHQpIHtcbiAgICB2YXIgbWV0aG9kID0gZGVsZWdhdGUuaXRlcmF0b3JbY29udGV4dC5tZXRob2RdO1xuICAgIGlmIChtZXRob2QgPT09IHVuZGVmaW5lZCkge1xuICAgICAgLy8gQSAudGhyb3cgb3IgLnJldHVybiB3aGVuIHRoZSBkZWxlZ2F0ZSBpdGVyYXRvciBoYXMgbm8gLnRocm93XG4gICAgICAvLyBtZXRob2QgYWx3YXlzIHRlcm1pbmF0ZXMgdGhlIHlpZWxkKiBsb29wLlxuICAgICAgY29udGV4dC5kZWxlZ2F0ZSA9IG51bGw7XG5cbiAgICAgIGlmIChjb250ZXh0Lm1ldGhvZCA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgIC8vIE5vdGU6IFtcInJldHVyblwiXSBtdXN0IGJlIHVzZWQgZm9yIEVTMyBwYXJzaW5nIGNvbXBhdGliaWxpdHkuXG4gICAgICAgIGlmIChkZWxlZ2F0ZS5pdGVyYXRvcltcInJldHVyblwiXSkge1xuICAgICAgICAgIC8vIElmIHRoZSBkZWxlZ2F0ZSBpdGVyYXRvciBoYXMgYSByZXR1cm4gbWV0aG9kLCBnaXZlIGl0IGFcbiAgICAgICAgICAvLyBjaGFuY2UgdG8gY2xlYW4gdXAuXG4gICAgICAgICAgY29udGV4dC5tZXRob2QgPSBcInJldHVyblwiO1xuICAgICAgICAgIGNvbnRleHQuYXJnID0gdW5kZWZpbmVkO1xuICAgICAgICAgIG1heWJlSW52b2tlRGVsZWdhdGUoZGVsZWdhdGUsIGNvbnRleHQpO1xuXG4gICAgICAgICAgaWYgKGNvbnRleHQubWV0aG9kID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICAgIC8vIElmIG1heWJlSW52b2tlRGVsZWdhdGUoY29udGV4dCkgY2hhbmdlZCBjb250ZXh0Lm1ldGhvZCBmcm9tXG4gICAgICAgICAgICAvLyBcInJldHVyblwiIHRvIFwidGhyb3dcIiwgbGV0IHRoYXQgb3ZlcnJpZGUgdGhlIFR5cGVFcnJvciBiZWxvdy5cbiAgICAgICAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnRleHQubWV0aG9kID0gXCJ0aHJvd1wiO1xuICAgICAgICBjb250ZXh0LmFyZyA9IG5ldyBUeXBlRXJyb3IoXG4gICAgICAgICAgXCJUaGUgaXRlcmF0b3IgZG9lcyBub3QgcHJvdmlkZSBhICd0aHJvdycgbWV0aG9kXCIpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICB9XG5cbiAgICB2YXIgcmVjb3JkID0gdHJ5Q2F0Y2gobWV0aG9kLCBkZWxlZ2F0ZS5pdGVyYXRvciwgY29udGV4dC5hcmcpO1xuXG4gICAgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgIGNvbnRleHQubWV0aG9kID0gXCJ0aHJvd1wiO1xuICAgICAgY29udGV4dC5hcmcgPSByZWNvcmQuYXJnO1xuICAgICAgY29udGV4dC5kZWxlZ2F0ZSA9IG51bGw7XG4gICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICB9XG5cbiAgICB2YXIgaW5mbyA9IHJlY29yZC5hcmc7XG5cbiAgICBpZiAoISBpbmZvKSB7XG4gICAgICBjb250ZXh0Lm1ldGhvZCA9IFwidGhyb3dcIjtcbiAgICAgIGNvbnRleHQuYXJnID0gbmV3IFR5cGVFcnJvcihcIml0ZXJhdG9yIHJlc3VsdCBpcyBub3QgYW4gb2JqZWN0XCIpO1xuICAgICAgY29udGV4dC5kZWxlZ2F0ZSA9IG51bGw7XG4gICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICB9XG5cbiAgICBpZiAoaW5mby5kb25lKSB7XG4gICAgICAvLyBBc3NpZ24gdGhlIHJlc3VsdCBvZiB0aGUgZmluaXNoZWQgZGVsZWdhdGUgdG8gdGhlIHRlbXBvcmFyeVxuICAgICAgLy8gdmFyaWFibGUgc3BlY2lmaWVkIGJ5IGRlbGVnYXRlLnJlc3VsdE5hbWUgKHNlZSBkZWxlZ2F0ZVlpZWxkKS5cbiAgICAgIGNvbnRleHRbZGVsZWdhdGUucmVzdWx0TmFtZV0gPSBpbmZvLnZhbHVlO1xuXG4gICAgICAvLyBSZXN1bWUgZXhlY3V0aW9uIGF0IHRoZSBkZXNpcmVkIGxvY2F0aW9uIChzZWUgZGVsZWdhdGVZaWVsZCkuXG4gICAgICBjb250ZXh0Lm5leHQgPSBkZWxlZ2F0ZS5uZXh0TG9jO1xuXG4gICAgICAvLyBJZiBjb250ZXh0Lm1ldGhvZCB3YXMgXCJ0aHJvd1wiIGJ1dCB0aGUgZGVsZWdhdGUgaGFuZGxlZCB0aGVcbiAgICAgIC8vIGV4Y2VwdGlvbiwgbGV0IHRoZSBvdXRlciBnZW5lcmF0b3IgcHJvY2VlZCBub3JtYWxseS4gSWZcbiAgICAgIC8vIGNvbnRleHQubWV0aG9kIHdhcyBcIm5leHRcIiwgZm9yZ2V0IGNvbnRleHQuYXJnIHNpbmNlIGl0IGhhcyBiZWVuXG4gICAgICAvLyBcImNvbnN1bWVkXCIgYnkgdGhlIGRlbGVnYXRlIGl0ZXJhdG9yLiBJZiBjb250ZXh0Lm1ldGhvZCB3YXNcbiAgICAgIC8vIFwicmV0dXJuXCIsIGFsbG93IHRoZSBvcmlnaW5hbCAucmV0dXJuIGNhbGwgdG8gY29udGludWUgaW4gdGhlXG4gICAgICAvLyBvdXRlciBnZW5lcmF0b3IuXG4gICAgICBpZiAoY29udGV4dC5tZXRob2QgIT09IFwicmV0dXJuXCIpIHtcbiAgICAgICAgY29udGV4dC5tZXRob2QgPSBcIm5leHRcIjtcbiAgICAgICAgY29udGV4dC5hcmcgPSB1bmRlZmluZWQ7XG4gICAgICB9XG5cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gUmUteWllbGQgdGhlIHJlc3VsdCByZXR1cm5lZCBieSB0aGUgZGVsZWdhdGUgbWV0aG9kLlxuICAgICAgcmV0dXJuIGluZm87XG4gICAgfVxuXG4gICAgLy8gVGhlIGRlbGVnYXRlIGl0ZXJhdG9yIGlzIGZpbmlzaGVkLCBzbyBmb3JnZXQgaXQgYW5kIGNvbnRpbnVlIHdpdGhcbiAgICAvLyB0aGUgb3V0ZXIgZ2VuZXJhdG9yLlxuICAgIGNvbnRleHQuZGVsZWdhdGUgPSBudWxsO1xuICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICB9XG5cbiAgLy8gRGVmaW5lIEdlbmVyYXRvci5wcm90b3R5cGUue25leHQsdGhyb3cscmV0dXJufSBpbiB0ZXJtcyBvZiB0aGVcbiAgLy8gdW5pZmllZCAuX2ludm9rZSBoZWxwZXIgbWV0aG9kLlxuICBkZWZpbmVJdGVyYXRvck1ldGhvZHMoR3ApO1xuXG4gIEdwW3RvU3RyaW5nVGFnU3ltYm9sXSA9IFwiR2VuZXJhdG9yXCI7XG5cbiAgLy8gQSBHZW5lcmF0b3Igc2hvdWxkIGFsd2F5cyByZXR1cm4gaXRzZWxmIGFzIHRoZSBpdGVyYXRvciBvYmplY3Qgd2hlbiB0aGVcbiAgLy8gQEBpdGVyYXRvciBmdW5jdGlvbiBpcyBjYWxsZWQgb24gaXQuIFNvbWUgYnJvd3NlcnMnIGltcGxlbWVudGF0aW9ucyBvZiB0aGVcbiAgLy8gaXRlcmF0b3IgcHJvdG90eXBlIGNoYWluIGluY29ycmVjdGx5IGltcGxlbWVudCB0aGlzLCBjYXVzaW5nIHRoZSBHZW5lcmF0b3JcbiAgLy8gb2JqZWN0IHRvIG5vdCBiZSByZXR1cm5lZCBmcm9tIHRoaXMgY2FsbC4gVGhpcyBlbnN1cmVzIHRoYXQgZG9lc24ndCBoYXBwZW4uXG4gIC8vIFNlZSBodHRwczovL2dpdGh1Yi5jb20vZmFjZWJvb2svcmVnZW5lcmF0b3IvaXNzdWVzLzI3NCBmb3IgbW9yZSBkZXRhaWxzLlxuICBHcFtpdGVyYXRvclN5bWJvbF0gPSBmdW5jdGlvbigpIHtcbiAgICByZXR1cm4gdGhpcztcbiAgfTtcblxuICBHcC50b1N0cmluZyA9IGZ1bmN0aW9uKCkge1xuICAgIHJldHVybiBcIltvYmplY3QgR2VuZXJhdG9yXVwiO1xuICB9O1xuXG4gIGZ1bmN0aW9uIHB1c2hUcnlFbnRyeShsb2NzKSB7XG4gICAgdmFyIGVudHJ5ID0geyB0cnlMb2M6IGxvY3NbMF0gfTtcblxuICAgIGlmICgxIGluIGxvY3MpIHtcbiAgICAgIGVudHJ5LmNhdGNoTG9jID0gbG9jc1sxXTtcbiAgICB9XG5cbiAgICBpZiAoMiBpbiBsb2NzKSB7XG4gICAgICBlbnRyeS5maW5hbGx5TG9jID0gbG9jc1syXTtcbiAgICAgIGVudHJ5LmFmdGVyTG9jID0gbG9jc1szXTtcbiAgICB9XG5cbiAgICB0aGlzLnRyeUVudHJpZXMucHVzaChlbnRyeSk7XG4gIH1cblxuICBmdW5jdGlvbiByZXNldFRyeUVudHJ5KGVudHJ5KSB7XG4gICAgdmFyIHJlY29yZCA9IGVudHJ5LmNvbXBsZXRpb24gfHwge307XG4gICAgcmVjb3JkLnR5cGUgPSBcIm5vcm1hbFwiO1xuICAgIGRlbGV0ZSByZWNvcmQuYXJnO1xuICAgIGVudHJ5LmNvbXBsZXRpb24gPSByZWNvcmQ7XG4gIH1cblxuICBmdW5jdGlvbiBDb250ZXh0KHRyeUxvY3NMaXN0KSB7XG4gICAgLy8gVGhlIHJvb3QgZW50cnkgb2JqZWN0IChlZmZlY3RpdmVseSBhIHRyeSBzdGF0ZW1lbnQgd2l0aG91dCBhIGNhdGNoXG4gICAgLy8gb3IgYSBmaW5hbGx5IGJsb2NrKSBnaXZlcyB1cyBhIHBsYWNlIHRvIHN0b3JlIHZhbHVlcyB0aHJvd24gZnJvbVxuICAgIC8vIGxvY2F0aW9ucyB3aGVyZSB0aGVyZSBpcyBubyBlbmNsb3NpbmcgdHJ5IHN0YXRlbWVudC5cbiAgICB0aGlzLnRyeUVudHJpZXMgPSBbeyB0cnlMb2M6IFwicm9vdFwiIH1dO1xuICAgIHRyeUxvY3NMaXN0LmZvckVhY2gocHVzaFRyeUVudHJ5LCB0aGlzKTtcbiAgICB0aGlzLnJlc2V0KHRydWUpO1xuICB9XG5cbiAgZXhwb3J0cy5rZXlzID0gZnVuY3Rpb24ob2JqZWN0KSB7XG4gICAgdmFyIGtleXMgPSBbXTtcbiAgICBmb3IgKHZhciBrZXkgaW4gb2JqZWN0KSB7XG4gICAgICBrZXlzLnB1c2goa2V5KTtcbiAgICB9XG4gICAga2V5cy5yZXZlcnNlKCk7XG5cbiAgICAvLyBSYXRoZXIgdGhhbiByZXR1cm5pbmcgYW4gb2JqZWN0IHdpdGggYSBuZXh0IG1ldGhvZCwgd2Uga2VlcFxuICAgIC8vIHRoaW5ncyBzaW1wbGUgYW5kIHJldHVybiB0aGUgbmV4dCBmdW5jdGlvbiBpdHNlbGYuXG4gICAgcmV0dXJuIGZ1bmN0aW9uIG5leHQoKSB7XG4gICAgICB3aGlsZSAoa2V5cy5sZW5ndGgpIHtcbiAgICAgICAgdmFyIGtleSA9IGtleXMucG9wKCk7XG4gICAgICAgIGlmIChrZXkgaW4gb2JqZWN0KSB7XG4gICAgICAgICAgbmV4dC52YWx1ZSA9IGtleTtcbiAgICAgICAgICBuZXh0LmRvbmUgPSBmYWxzZTtcbiAgICAgICAgICByZXR1cm4gbmV4dDtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBUbyBhdm9pZCBjcmVhdGluZyBhbiBhZGRpdGlvbmFsIG9iamVjdCwgd2UganVzdCBoYW5nIHRoZSAudmFsdWVcbiAgICAgIC8vIGFuZCAuZG9uZSBwcm9wZXJ0aWVzIG9mZiB0aGUgbmV4dCBmdW5jdGlvbiBvYmplY3QgaXRzZWxmLiBUaGlzXG4gICAgICAvLyBhbHNvIGVuc3VyZXMgdGhhdCB0aGUgbWluaWZpZXIgd2lsbCBub3QgYW5vbnltaXplIHRoZSBmdW5jdGlvbi5cbiAgICAgIG5leHQuZG9uZSA9IHRydWU7XG4gICAgICByZXR1cm4gbmV4dDtcbiAgICB9O1xuICB9O1xuXG4gIGZ1bmN0aW9uIHZhbHVlcyhpdGVyYWJsZSkge1xuICAgIGlmIChpdGVyYWJsZSkge1xuICAgICAgdmFyIGl0ZXJhdG9yTWV0aG9kID0gaXRlcmFibGVbaXRlcmF0b3JTeW1ib2xdO1xuICAgICAgaWYgKGl0ZXJhdG9yTWV0aG9kKSB7XG4gICAgICAgIHJldHVybiBpdGVyYXRvck1ldGhvZC5jYWxsKGl0ZXJhYmxlKTtcbiAgICAgIH1cblxuICAgICAgaWYgKHR5cGVvZiBpdGVyYWJsZS5uZXh0ID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgcmV0dXJuIGl0ZXJhYmxlO1xuICAgICAgfVxuXG4gICAgICBpZiAoIWlzTmFOKGl0ZXJhYmxlLmxlbmd0aCkpIHtcbiAgICAgICAgdmFyIGkgPSAtMSwgbmV4dCA9IGZ1bmN0aW9uIG5leHQoKSB7XG4gICAgICAgICAgd2hpbGUgKCsraSA8IGl0ZXJhYmxlLmxlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGhhc093bi5jYWxsKGl0ZXJhYmxlLCBpKSkge1xuICAgICAgICAgICAgICBuZXh0LnZhbHVlID0gaXRlcmFibGVbaV07XG4gICAgICAgICAgICAgIG5leHQuZG9uZSA9IGZhbHNlO1xuICAgICAgICAgICAgICByZXR1cm4gbmV4dDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG5cbiAgICAgICAgICBuZXh0LnZhbHVlID0gdW5kZWZpbmVkO1xuICAgICAgICAgIG5leHQuZG9uZSA9IHRydWU7XG5cbiAgICAgICAgICByZXR1cm4gbmV4dDtcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gbmV4dC5uZXh0ID0gbmV4dDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSZXR1cm4gYW4gaXRlcmF0b3Igd2l0aCBubyB2YWx1ZXMuXG4gICAgcmV0dXJuIHsgbmV4dDogZG9uZVJlc3VsdCB9O1xuICB9XG4gIGV4cG9ydHMudmFsdWVzID0gdmFsdWVzO1xuXG4gIGZ1bmN0aW9uIGRvbmVSZXN1bHQoKSB7XG4gICAgcmV0dXJuIHsgdmFsdWU6IHVuZGVmaW5lZCwgZG9uZTogdHJ1ZSB9O1xuICB9XG5cbiAgQ29udGV4dC5wcm90b3R5cGUgPSB7XG4gICAgY29uc3RydWN0b3I6IENvbnRleHQsXG5cbiAgICByZXNldDogZnVuY3Rpb24oc2tpcFRlbXBSZXNldCkge1xuICAgICAgdGhpcy5wcmV2ID0gMDtcbiAgICAgIHRoaXMubmV4dCA9IDA7XG4gICAgICAvLyBSZXNldHRpbmcgY29udGV4dC5fc2VudCBmb3IgbGVnYWN5IHN1cHBvcnQgb2YgQmFiZWwnc1xuICAgICAgLy8gZnVuY3Rpb24uc2VudCBpbXBsZW1lbnRhdGlvbi5cbiAgICAgIHRoaXMuc2VudCA9IHRoaXMuX3NlbnQgPSB1bmRlZmluZWQ7XG4gICAgICB0aGlzLmRvbmUgPSBmYWxzZTtcbiAgICAgIHRoaXMuZGVsZWdhdGUgPSBudWxsO1xuXG4gICAgICB0aGlzLm1ldGhvZCA9IFwibmV4dFwiO1xuICAgICAgdGhpcy5hcmcgPSB1bmRlZmluZWQ7XG5cbiAgICAgIHRoaXMudHJ5RW50cmllcy5mb3JFYWNoKHJlc2V0VHJ5RW50cnkpO1xuXG4gICAgICBpZiAoIXNraXBUZW1wUmVzZXQpIHtcbiAgICAgICAgZm9yICh2YXIgbmFtZSBpbiB0aGlzKSB7XG4gICAgICAgICAgLy8gTm90IHN1cmUgYWJvdXQgdGhlIG9wdGltYWwgb3JkZXIgb2YgdGhlc2UgY29uZGl0aW9uczpcbiAgICAgICAgICBpZiAobmFtZS5jaGFyQXQoMCkgPT09IFwidFwiICYmXG4gICAgICAgICAgICAgIGhhc093bi5jYWxsKHRoaXMsIG5hbWUpICYmXG4gICAgICAgICAgICAgICFpc05hTigrbmFtZS5zbGljZSgxKSkpIHtcbiAgICAgICAgICAgIHRoaXNbbmFtZV0gPSB1bmRlZmluZWQ7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSxcblxuICAgIHN0b3A6IGZ1bmN0aW9uKCkge1xuICAgICAgdGhpcy5kb25lID0gdHJ1ZTtcblxuICAgICAgdmFyIHJvb3RFbnRyeSA9IHRoaXMudHJ5RW50cmllc1swXTtcbiAgICAgIHZhciByb290UmVjb3JkID0gcm9vdEVudHJ5LmNvbXBsZXRpb247XG4gICAgICBpZiAocm9vdFJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgdGhyb3cgcm9vdFJlY29yZC5hcmc7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB0aGlzLnJ2YWw7XG4gICAgfSxcblxuICAgIGRpc3BhdGNoRXhjZXB0aW9uOiBmdW5jdGlvbihleGNlcHRpb24pIHtcbiAgICAgIGlmICh0aGlzLmRvbmUpIHtcbiAgICAgICAgdGhyb3cgZXhjZXB0aW9uO1xuICAgICAgfVxuXG4gICAgICB2YXIgY29udGV4dCA9IHRoaXM7XG4gICAgICBmdW5jdGlvbiBoYW5kbGUobG9jLCBjYXVnaHQpIHtcbiAgICAgICAgcmVjb3JkLnR5cGUgPSBcInRocm93XCI7XG4gICAgICAgIHJlY29yZC5hcmcgPSBleGNlcHRpb247XG4gICAgICAgIGNvbnRleHQubmV4dCA9IGxvYztcblxuICAgICAgICBpZiAoY2F1Z2h0KSB7XG4gICAgICAgICAgLy8gSWYgdGhlIGRpc3BhdGNoZWQgZXhjZXB0aW9uIHdhcyBjYXVnaHQgYnkgYSBjYXRjaCBibG9jayxcbiAgICAgICAgICAvLyB0aGVuIGxldCB0aGF0IGNhdGNoIGJsb2NrIGhhbmRsZSB0aGUgZXhjZXB0aW9uIG5vcm1hbGx5LlxuICAgICAgICAgIGNvbnRleHQubWV0aG9kID0gXCJuZXh0XCI7XG4gICAgICAgICAgY29udGV4dC5hcmcgPSB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gISEgY2F1Z2h0O1xuICAgICAgfVxuXG4gICAgICBmb3IgKHZhciBpID0gdGhpcy50cnlFbnRyaWVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICAgIHZhciBlbnRyeSA9IHRoaXMudHJ5RW50cmllc1tpXTtcbiAgICAgICAgdmFyIHJlY29yZCA9IGVudHJ5LmNvbXBsZXRpb247XG5cbiAgICAgICAgaWYgKGVudHJ5LnRyeUxvYyA9PT0gXCJyb290XCIpIHtcbiAgICAgICAgICAvLyBFeGNlcHRpb24gdGhyb3duIG91dHNpZGUgb2YgYW55IHRyeSBibG9jayB0aGF0IGNvdWxkIGhhbmRsZVxuICAgICAgICAgIC8vIGl0LCBzbyBzZXQgdGhlIGNvbXBsZXRpb24gdmFsdWUgb2YgdGhlIGVudGlyZSBmdW5jdGlvbiB0b1xuICAgICAgICAgIC8vIHRocm93IHRoZSBleGNlcHRpb24uXG4gICAgICAgICAgcmV0dXJuIGhhbmRsZShcImVuZFwiKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChlbnRyeS50cnlMb2MgPD0gdGhpcy5wcmV2KSB7XG4gICAgICAgICAgdmFyIGhhc0NhdGNoID0gaGFzT3duLmNhbGwoZW50cnksIFwiY2F0Y2hMb2NcIik7XG4gICAgICAgICAgdmFyIGhhc0ZpbmFsbHkgPSBoYXNPd24uY2FsbChlbnRyeSwgXCJmaW5hbGx5TG9jXCIpO1xuXG4gICAgICAgICAgaWYgKGhhc0NhdGNoICYmIGhhc0ZpbmFsbHkpIHtcbiAgICAgICAgICAgIGlmICh0aGlzLnByZXYgPCBlbnRyeS5jYXRjaExvYykge1xuICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlKGVudHJ5LmNhdGNoTG9jLCB0cnVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5wcmV2IDwgZW50cnkuZmluYWxseUxvYykge1xuICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlKGVudHJ5LmZpbmFsbHlMb2MpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgfSBlbHNlIGlmIChoYXNDYXRjaCkge1xuICAgICAgICAgICAgaWYgKHRoaXMucHJldiA8IGVudHJ5LmNhdGNoTG9jKSB7XG4gICAgICAgICAgICAgIHJldHVybiBoYW5kbGUoZW50cnkuY2F0Y2hMb2MsIHRydWUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgfSBlbHNlIGlmIChoYXNGaW5hbGx5KSB7XG4gICAgICAgICAgICBpZiAodGhpcy5wcmV2IDwgZW50cnkuZmluYWxseUxvYykge1xuICAgICAgICAgICAgICByZXR1cm4gaGFuZGxlKGVudHJ5LmZpbmFsbHlMb2MpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcInRyeSBzdGF0ZW1lbnQgd2l0aG91dCBjYXRjaCBvciBmaW5hbGx5XCIpO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0sXG5cbiAgICBhYnJ1cHQ6IGZ1bmN0aW9uKHR5cGUsIGFyZykge1xuICAgICAgZm9yICh2YXIgaSA9IHRoaXMudHJ5RW50cmllcy5sZW5ndGggLSAxOyBpID49IDA7IC0taSkge1xuICAgICAgICB2YXIgZW50cnkgPSB0aGlzLnRyeUVudHJpZXNbaV07XG4gICAgICAgIGlmIChlbnRyeS50cnlMb2MgPD0gdGhpcy5wcmV2ICYmXG4gICAgICAgICAgICBoYXNPd24uY2FsbChlbnRyeSwgXCJmaW5hbGx5TG9jXCIpICYmXG4gICAgICAgICAgICB0aGlzLnByZXYgPCBlbnRyeS5maW5hbGx5TG9jKSB7XG4gICAgICAgICAgdmFyIGZpbmFsbHlFbnRyeSA9IGVudHJ5O1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChmaW5hbGx5RW50cnkgJiZcbiAgICAgICAgICAodHlwZSA9PT0gXCJicmVha1wiIHx8XG4gICAgICAgICAgIHR5cGUgPT09IFwiY29udGludWVcIikgJiZcbiAgICAgICAgICBmaW5hbGx5RW50cnkudHJ5TG9jIDw9IGFyZyAmJlxuICAgICAgICAgIGFyZyA8PSBmaW5hbGx5RW50cnkuZmluYWxseUxvYykge1xuICAgICAgICAvLyBJZ25vcmUgdGhlIGZpbmFsbHkgZW50cnkgaWYgY29udHJvbCBpcyBub3QganVtcGluZyB0byBhXG4gICAgICAgIC8vIGxvY2F0aW9uIG91dHNpZGUgdGhlIHRyeS9jYXRjaCBibG9jay5cbiAgICAgICAgZmluYWxseUVudHJ5ID0gbnVsbDtcbiAgICAgIH1cblxuICAgICAgdmFyIHJlY29yZCA9IGZpbmFsbHlFbnRyeSA/IGZpbmFsbHlFbnRyeS5jb21wbGV0aW9uIDoge307XG4gICAgICByZWNvcmQudHlwZSA9IHR5cGU7XG4gICAgICByZWNvcmQuYXJnID0gYXJnO1xuXG4gICAgICBpZiAoZmluYWxseUVudHJ5KSB7XG4gICAgICAgIHRoaXMubWV0aG9kID0gXCJuZXh0XCI7XG4gICAgICAgIHRoaXMubmV4dCA9IGZpbmFsbHlFbnRyeS5maW5hbGx5TG9jO1xuICAgICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRoaXMuY29tcGxldGUocmVjb3JkKTtcbiAgICB9LFxuXG4gICAgY29tcGxldGU6IGZ1bmN0aW9uKHJlY29yZCwgYWZ0ZXJMb2MpIHtcbiAgICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJ0aHJvd1wiKSB7XG4gICAgICAgIHRocm93IHJlY29yZC5hcmc7XG4gICAgICB9XG5cbiAgICAgIGlmIChyZWNvcmQudHlwZSA9PT0gXCJicmVha1wiIHx8XG4gICAgICAgICAgcmVjb3JkLnR5cGUgPT09IFwiY29udGludWVcIikge1xuICAgICAgICB0aGlzLm5leHQgPSByZWNvcmQuYXJnO1xuICAgICAgfSBlbHNlIGlmIChyZWNvcmQudHlwZSA9PT0gXCJyZXR1cm5cIikge1xuICAgICAgICB0aGlzLnJ2YWwgPSB0aGlzLmFyZyA9IHJlY29yZC5hcmc7XG4gICAgICAgIHRoaXMubWV0aG9kID0gXCJyZXR1cm5cIjtcbiAgICAgICAgdGhpcy5uZXh0ID0gXCJlbmRcIjtcbiAgICAgIH0gZWxzZSBpZiAocmVjb3JkLnR5cGUgPT09IFwibm9ybWFsXCIgJiYgYWZ0ZXJMb2MpIHtcbiAgICAgICAgdGhpcy5uZXh0ID0gYWZ0ZXJMb2M7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgIH0sXG5cbiAgICBmaW5pc2g6IGZ1bmN0aW9uKGZpbmFsbHlMb2MpIHtcbiAgICAgIGZvciAodmFyIGkgPSB0aGlzLnRyeUVudHJpZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyAtLWkpIHtcbiAgICAgICAgdmFyIGVudHJ5ID0gdGhpcy50cnlFbnRyaWVzW2ldO1xuICAgICAgICBpZiAoZW50cnkuZmluYWxseUxvYyA9PT0gZmluYWxseUxvYykge1xuICAgICAgICAgIHRoaXMuY29tcGxldGUoZW50cnkuY29tcGxldGlvbiwgZW50cnkuYWZ0ZXJMb2MpO1xuICAgICAgICAgIHJlc2V0VHJ5RW50cnkoZW50cnkpO1xuICAgICAgICAgIHJldHVybiBDb250aW51ZVNlbnRpbmVsO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSxcblxuICAgIFwiY2F0Y2hcIjogZnVuY3Rpb24odHJ5TG9jKSB7XG4gICAgICBmb3IgKHZhciBpID0gdGhpcy50cnlFbnRyaWVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICAgIHZhciBlbnRyeSA9IHRoaXMudHJ5RW50cmllc1tpXTtcbiAgICAgICAgaWYgKGVudHJ5LnRyeUxvYyA9PT0gdHJ5TG9jKSB7XG4gICAgICAgICAgdmFyIHJlY29yZCA9IGVudHJ5LmNvbXBsZXRpb247XG4gICAgICAgICAgaWYgKHJlY29yZC50eXBlID09PSBcInRocm93XCIpIHtcbiAgICAgICAgICAgIHZhciB0aHJvd24gPSByZWNvcmQuYXJnO1xuICAgICAgICAgICAgcmVzZXRUcnlFbnRyeShlbnRyeSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0aHJvd247XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVGhlIGNvbnRleHQuY2F0Y2ggbWV0aG9kIG11c3Qgb25seSBiZSBjYWxsZWQgd2l0aCBhIGxvY2F0aW9uXG4gICAgICAvLyBhcmd1bWVudCB0aGF0IGNvcnJlc3BvbmRzIHRvIGEga25vd24gY2F0Y2ggYmxvY2suXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJpbGxlZ2FsIGNhdGNoIGF0dGVtcHRcIik7XG4gICAgfSxcblxuICAgIGRlbGVnYXRlWWllbGQ6IGZ1bmN0aW9uKGl0ZXJhYmxlLCByZXN1bHROYW1lLCBuZXh0TG9jKSB7XG4gICAgICB0aGlzLmRlbGVnYXRlID0ge1xuICAgICAgICBpdGVyYXRvcjogdmFsdWVzKGl0ZXJhYmxlKSxcbiAgICAgICAgcmVzdWx0TmFtZTogcmVzdWx0TmFtZSxcbiAgICAgICAgbmV4dExvYzogbmV4dExvY1xuICAgICAgfTtcblxuICAgICAgaWYgKHRoaXMubWV0aG9kID09PSBcIm5leHRcIikge1xuICAgICAgICAvLyBEZWxpYmVyYXRlbHkgZm9yZ2V0IHRoZSBsYXN0IHNlbnQgdmFsdWUgc28gdGhhdCB3ZSBkb24ndFxuICAgICAgICAvLyBhY2NpZGVudGFsbHkgcGFzcyBpdCBvbiB0byB0aGUgZGVsZWdhdGUuXG4gICAgICAgIHRoaXMuYXJnID0gdW5kZWZpbmVkO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gQ29udGludWVTZW50aW5lbDtcbiAgICB9XG4gIH07XG5cbiAgLy8gUmVnYXJkbGVzcyBvZiB3aGV0aGVyIHRoaXMgc2NyaXB0IGlzIGV4ZWN1dGluZyBhcyBhIENvbW1vbkpTIG1vZHVsZVxuICAvLyBvciBub3QsIHJldHVybiB0aGUgcnVudGltZSBvYmplY3Qgc28gdGhhdCB3ZSBjYW4gZGVjbGFyZSB0aGUgdmFyaWFibGVcbiAgLy8gcmVnZW5lcmF0b3JSdW50aW1lIGluIHRoZSBvdXRlciBzY29wZSwgd2hpY2ggYWxsb3dzIHRoaXMgbW9kdWxlIHRvIGJlXG4gIC8vIGluamVjdGVkIGVhc2lseSBieSBgYmluL3JlZ2VuZXJhdG9yIC0taW5jbHVkZS1ydW50aW1lIHNjcmlwdC5qc2AuXG4gIHJldHVybiBleHBvcnRzO1xuXG59KFxuICAvLyBJZiB0aGlzIHNjcmlwdCBpcyBleGVjdXRpbmcgYXMgYSBDb21tb25KUyBtb2R1bGUsIHVzZSBtb2R1bGUuZXhwb3J0c1xuICAvLyBhcyB0aGUgcmVnZW5lcmF0b3JSdW50aW1lIG5hbWVzcGFjZS4gT3RoZXJ3aXNlIGNyZWF0ZSBhIG5ldyBlbXB0eVxuICAvLyBvYmplY3QuIEVpdGhlciB3YXksIHRoZSByZXN1bHRpbmcgb2JqZWN0IHdpbGwgYmUgdXNlZCB0byBpbml0aWFsaXplXG4gIC8vIHRoZSByZWdlbmVyYXRvclJ1bnRpbWUgdmFyaWFibGUgYXQgdGhlIHRvcCBvZiB0aGlzIGZpbGUuXG4gIHR5cGVvZiBtb2R1bGUgPT09IFwib2JqZWN0XCIgPyBtb2R1bGUuZXhwb3J0cyA6IHt9XG4pKTtcblxudHJ5IHtcbiAgcmVnZW5lcmF0b3JSdW50aW1lID0gcnVudGltZTtcbn0gY2F0Y2ggKGFjY2lkZW50YWxTdHJpY3RNb2RlKSB7XG4gIC8vIFRoaXMgbW9kdWxlIHNob3VsZCBub3QgYmUgcnVubmluZyBpbiBzdHJpY3QgbW9kZSwgc28gdGhlIGFib3ZlXG4gIC8vIGFzc2lnbm1lbnQgc2hvdWxkIGFsd2F5cyB3b3JrIHVubGVzcyBzb21ldGhpbmcgaXMgbWlzY29uZmlndXJlZC4gSnVzdFxuICAvLyBpbiBjYXNlIHJ1bnRpbWUuanMgYWNjaWRlbnRhbGx5IHJ1bnMgaW4gc3RyaWN0IG1vZGUsIHdlIGNhbiBlc2NhcGVcbiAgLy8gc3RyaWN0IG1vZGUgdXNpbmcgYSBnbG9iYWwgRnVuY3Rpb24gY2FsbC4gVGhpcyBjb3VsZCBjb25jZWl2YWJseSBmYWlsXG4gIC8vIGlmIGEgQ29udGVudCBTZWN1cml0eSBQb2xpY3kgZm9yYmlkcyB1c2luZyBGdW5jdGlvbiwgYnV0IGluIHRoYXQgY2FzZVxuICAvLyB0aGUgcHJvcGVyIHNvbHV0aW9uIGlzIHRvIGZpeCB0aGUgYWNjaWRlbnRhbCBzdHJpY3QgbW9kZSBwcm9ibGVtLiBJZlxuICAvLyB5b3UndmUgbWlzY29uZmlndXJlZCB5b3VyIGJ1bmRsZXIgdG8gZm9yY2Ugc3RyaWN0IG1vZGUgYW5kIGFwcGxpZWQgYVxuICAvLyBDU1AgdG8gZm9yYmlkIEZ1bmN0aW9uLCBhbmQgeW91J3JlIG5vdCB3aWxsaW5nIHRvIGZpeCBlaXRoZXIgb2YgdGhvc2VcbiAgLy8gcHJvYmxlbXMsIHBsZWFzZSBkZXRhaWwgeW91ciB1bmlxdWUgcHJlZGljYW1lbnQgaW4gYSBHaXRIdWIgaXNzdWUuXG4gIEZ1bmN0aW9uKFwiclwiLCBcInJlZ2VuZXJhdG9yUnVudGltZSA9IHJcIikocnVudGltZSk7XG59XG4iLCJjb25zdCByZWdlbmVyYXRvclJ1bnRpbWUgPSByZXF1aXJlKFwicmVnZW5lcmF0b3ItcnVudGltZVwiKTtcclxuXHJcbmNvbnN0IHRvcGxpbmUgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLm1lbnVcIik7XHJcbmNvbnN0IG1vYmlsZU1lbnUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vYmlsZU1lbnVcIik7XHJcbmNvbnN0IGNsb3NlQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjbG9zZUJ0blwiKTtcclxuY29uc3QgYnVyZ2VyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJidXJnZXJcIik7XHJcbmNvbnN0IG1vYmlsZUxpc3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vYmlsZUxpc3RcIik7XHJcbmNvbnN0IHNlZU1vcmUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNlZU1vcmVcIik7XHJcbmxldCBjb3VudGVyID0gMztcclxuY29uc3QgcHJvZHVjdHMgPSBbXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy9NYXNrIEdyb3VwLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiSW5kb29yIGVuZXJneSBzZXJ2aWNlc1wiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBoZWxwZWQgSW5kb29yIGVuZXJneSBzZXJ2aWNlcyB0byBncmVhdHkgc2ltcGxpZnkgdGhlaXIgY2FzZSBtYW5hZ2VtZW50IHN5c3RlbS4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nL01hc2sgR3JvdXAgKDEpLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiQmlyZGllIEdvbGQgVG91cnNcIixcclxuICAgIHRleHQ6XHJcbiAgICAgIFwiV2UgaGVscGVkIEJpcmR5IEdvbGYgVG91cnMgdG8gc3RheSByZWxldmVhbnQgb24gYW4gaW5jbHJlYXNpbmdseSBjb21wZXRpdGl2ZSBtYXJrZXQuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy9NYXNrIEdyb3VwICgyKS5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIk5vd1doZXJlXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGJ1aWx0IGEgcmVjb21tZW5kYXRpb25zIGFwcCBmb3IgcGVvcGxlIHdvcmtpbmcgaW4gY3JlYXRpdmUgaW5kdXN0cmllcy4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nL01hc2sgR3JvdXAgKDMpLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiRnluZGlxc3ZhanBlblwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBjcmVhdGVkIGFuIGFwcCB0aGF0IGhlbHBlZCBjdXN0b21lcnMgZmluZCBnaWZ0cyBhbW9uZyBtb3JlIHRoYW4gMjkwMDAwMCBpdGVtcy4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nL01hc2sgR3JvdXAgKDQpLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiQnl0aGp1bFwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBjcmVhdGVkIHRpcmUgZmFzaGlvbiBmb3IgdGhlIGluY3JlYXNpbmdseSBlZ2FsaXRhcmlhbiBjYXIgbWFpbnRpbmFjZSBtYXJrZXQuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy9NYXNrIEdyb3VwICg1KS5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlRpY2tpblwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBpbnZlbnRlZCBhIHRpbWUgcmVwb3J0aW5nIHN5c3RlbSBmb3IgcGVvcGxlIHdobyBoYXRlIHRpbWUgdHJhY2tpbmcuLi5cIlxyXG4gIH0sXHJcbiAge1xyXG4gICAgc3JjOiBcImltZy9NYXNrIEdyb3VwICg2KS5qcGdcIixcclxuICAgIHN1YnRpdGxlOiBcIlViZXJtZWRzXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGNyZWF0ZWQgYW4gYXBwIHRoYXQgaGVscGVkIGN1c3RvbWVycyBmaW5kIGdpZnRzIGFtb25nIG1vcmUgdGhhbiAyOTAwMDAwIGl0ZW1zLi4uXCJcclxuICB9LFxyXG4gIHtcclxuICAgIHNyYzogXCJpbWcvTWFzayBHcm91cCAoNykuanBnXCIsXHJcbiAgICBzdWJ0aXRsZTogXCJWw6RzdHRyYWZpayBDYWxjdWxhdG9yXCIsXHJcbiAgICB0ZXh0OlxyXG4gICAgICBcIldlIGNyZWF0ZWQgdGlyZSBmYXNoaW9uIGZvciB0aGUgaW5jcmVhc2luZ2x5IGVnYWxpdGFyaWFuIGNhciBtYWludGluYWNlIG1hcmtldC4uLlwiXHJcbiAgfSxcclxuICB7XHJcbiAgICBzcmM6IFwiaW1nL01hc2sgR3JvdXAgKDgpLmpwZ1wiLFxyXG4gICAgc3VidGl0bGU6IFwiVHLDpG5pbmdzcGFydG5lclwiLFxyXG4gICAgdGV4dDpcclxuICAgICAgXCJXZSBpbnZlbnRlZCBhIHRpbWUgcmVwb3J0aW5nIHN5c3RlbSBmb3IgcGVvcGxlIHdobyBoYXRlIHRpbWUgdHJhY2tpbmcuLi5cIlxyXG4gIH1cclxuXTtcclxuXHJcbmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJzY3JvbGxcIiwgKCkgPT4ge1xyXG4gIGlmICh3aW5kb3cucGFnZVlPZmZzZXQgPCB0b3BsaW5lLmNsaWVudEhlaWdodCkge1xyXG4gICAgdG9wbGluZS5jbGFzc0xpc3QucmVtb3ZlKFwiZml4ZWRcIik7XHJcbiAgfSBlbHNlIHtcclxuICAgIHRvcGxpbmUuY2xhc3NMaXN0LmFkZChcImZpeGVkXCIpO1xyXG4gIH1cclxufSk7XHJcblxyXG5idXJnZXIub25jbGljayA9IGUgPT4ge1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICBtb2JpbGVNZW51LmNsYXNzTGlzdC50b2dnbGUoXCJoaWRlXCIpO1xyXG59O1xyXG5cclxuY2xvc2VCdG4ub25jbGljayA9IGUgPT4ge1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICBtb2JpbGVNZW51LmNsYXNzTGlzdC50b2dnbGUoXCJoaWRlXCIpO1xyXG59O1xyXG5cclxubW9iaWxlTGlzdC5vbmNsaWNrID0gKCkgPT4ge1xyXG4gIG1vYmlsZU1lbnUuY2xhc3NMaXN0LnRvZ2dsZShcImhpZGVcIik7XHJcbn07XHJcblxyXG5cclxuXHJcbmNvbnN0IHJlbmRlclByb2R1Y3RzID0gaXRlbSA9PiB7XHJcbiAgcmV0dXJuIGA8ZGl2IGNsYXNzPVwiY29sLTEyIGNvbC1tZC02IGNvbC1sZy00XCI+XHJcbiAgPGRpdiBjbGFzcz1cInByb2plY3RzX19jYXJkXCI+XHJcbiAgICA8aW1nIHNyYz1cIiR7aXRlbS5zcmN9XCIgYWx0PVwibWFza1wiPlxyXG4gICAgPGRpdiBjbGFzcz1cInByb2plY3RzX19pbmZvXCI+XHJcbiAgICAgIDxoNCBjbGFzcz1cInByb2plY3RzX19zdWJ0aXRsZVwiPiR7aXRlbS5zdWJ0aXRsZX08L2g0PlxyXG4gICAgICA8cCBjbGFzcz1cInByb2plY3RzX190ZXh0XCI+JHtpdGVtLnRleHR9PC9wPlxyXG4gICAgPC9kaXY+XHJcbiAgPC9kaXY+XHJcbjwvZGl2PmA7XHJcbn07XHJcblxyXG5sZXQgcmVuZGVyU2VjdGlvbiA9IHByb2plY3RzRGF0YSA9PiB7XHJcbiAgY29uc3QgcHJvamVjdHMgPSAgcHJvamVjdHNEYXRhLm1hcChlbGVtZW50ID0+IHJlbmRlclByb2R1Y3RzKGVsZW1lbnQpKTtcclxuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInByb2plY3RzUmVuZGVyXCIpLmlubmVySFRNTCA9IHByb2plY3RzLmpvaW4oXCJcIik7XHJcbn07XHJcblxyXG5zZWVNb3JlLm9uY2xpY2sgPSBlID0+IHtcclxuICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgY291bnRlciArPSAzO1xyXG4gIHJlbmRlclNlY3Rpb24ocHJvZHVjdHMuc2xpY2UoMCwgY291bnRlcikpXHJcbn1cclxuXHJcbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCAoKSA9PiB7XHJcbiAgY29uc3Qgd2l0ZGhDb3VudGVyID0gYXN5bmMgKCkgPT4ge1xyXG4gICAgc3dpdGNoICh0cnVlKSB7XHJcbiAgICAgIGNhc2UgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LmNsaWVudFdpZHRoID4gNzY4OlxyXG4gICAgICAgIGNvdW50ZXIgPSA5O1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgICBkZWZhdWx0OlxyXG4gICAgICAgIGNvdW50ZXIgPSAzO1xyXG4gICAgICAgIGJyZWFrO1xyXG4gICAgfVxyXG4gIH07XHJcbiAgd2l0ZGhDb3VudGVyKCk7XHJcbiAgcmVuZGVyU2VjdGlvbihwcm9kdWN0cy5zbGljZSgwLCBjb3VudGVyKSlcclxufSkiXSwicHJlRXhpc3RpbmdDb21tZW50IjoiLy8jIHNvdXJjZU1hcHBpbmdVUkw9ZGF0YTphcHBsaWNhdGlvbi9qc29uO2NoYXJzZXQ9dXRmLTg7YmFzZTY0LGV5SjJaWEp6YVc5dUlqb3pMQ0p6YjNWeVkyVnpJanBiSW01dlpHVmZiVzlrZFd4bGN5OWljbTkzYzJWeUxYQmhZMnN2WDNCeVpXeDFaR1V1YW5NaUxDSnViMlJsWDIxdlpIVnNaWE12Y21WblpXNWxjbUYwYjNJdGNuVnVkR2x0WlM5eWRXNTBhVzFsTG1weklpd2ljSEp2YW1WamRITXZkMmhwZEdWd2IzSjBMWE5wZEdVdmMzSmpMMnB6TDJGd2NDNXFjeUpkTENKdVlXMWxjeUk2VzEwc0ltMWhjSEJwYm1keklqb2lRVUZCUVR0QlEwRkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CTzBGQlEwRTdRVUZEUVR0QlFVTkJPMEZCUTBFN1FVRkRRVHRCUVVOQk8wRkJRMEU3UVVGRFFUdEJRVU5CT3pzN08wRkRkSFJDUVN4SlFVRk5MR3RDUVVGclFpeEhRVUZITEU5QlFVOHNRMEZCUXl4eFFrRkJSQ3hEUVVGc1F6czdRVUZGUVN4SlFVRk5MRTlCUVU4c1IwRkJSeXhSUVVGUkxFTkJRVU1zWVVGQlZDeERRVUYxUWl4UFFVRjJRaXhEUVVGb1FqdEJRVU5CTEVsQlFVMHNWVUZCVlN4SFFVRkhMRkZCUVZFc1EwRkJReXhqUVVGVUxFTkJRWGRDTEZsQlFYaENMRU5CUVc1Q08wRkJRMEVzU1VGQlRTeFJRVUZSTEVkQlFVY3NVVUZCVVN4RFFVRkRMR05CUVZRc1EwRkJkMElzVlVGQmVFSXNRMEZCYWtJN1FVRkRRU3hKUVVGTkxFMUJRVTBzUjBGQlJ5eFJRVUZSTEVOQlFVTXNZMEZCVkN4RFFVRjNRaXhSUVVGNFFpeERRVUZtTzBGQlEwRXNTVUZCVFN4VlFVRlZMRWRCUVVjc1VVRkJVU3hEUVVGRExHTkJRVlFzUTBGQmQwSXNXVUZCZUVJc1EwRkJia0k3UVVGRFFTeEpRVUZOTEU5QlFVOHNSMEZCUnl4UlFVRlJMRU5CUVVNc1kwRkJWQ3hEUVVGM1FpeFRRVUY0UWl4RFFVRm9RanRCUVVOQkxFbEJRVWtzVDBGQlR5eEhRVUZITEVOQlFXUTdRVUZEUVN4SlFVRk5MRkZCUVZFc1IwRkJSeXhEUVVObU8wRkJRMFVzUlVGQlFTeEhRVUZITEVWQlFVVXNiMEpCUkZBN1FVRkZSU3hGUVVGQkxGRkJRVkVzUlVGQlJTeDNRa0ZHV2p0QlFVZEZMRVZCUVVFc1NVRkJTU3hGUVVOR08wRkJTa29zUTBGRVpTeEZRVTltTzBGQlEwVXNSVUZCUVN4SFFVRkhMRVZCUVVVc2QwSkJSRkE3UVVGRlJTeEZRVUZCTEZGQlFWRXNSVUZCUlN4dFFrRkdXanRCUVVkRkxFVkJRVUVzU1VGQlNTeEZRVU5HTzBGQlNrb3NRMEZRWlN4RlFXRm1PMEZCUTBVc1JVRkJRU3hIUVVGSExFVkJRVVVzZDBKQlJGQTdRVUZGUlN4RlFVRkJMRkZCUVZFc1JVRkJSU3hWUVVaYU8wRkJSMFVzUlVGQlFTeEpRVUZKTEVWQlEwWTdRVUZLU2l4RFFXSmxMRVZCYlVKbU8wRkJRMFVzUlVGQlFTeEhRVUZITEVWQlFVVXNkMEpCUkZBN1FVRkZSU3hGUVVGQkxGRkJRVkVzUlVGQlJTeGxRVVphTzBGQlIwVXNSVUZCUVN4SlFVRkpMRVZCUTBZN1FVRktTaXhEUVc1Q1pTeEZRWGxDWmp0QlFVTkZMRVZCUVVFc1IwRkJSeXhGUVVGRkxIZENRVVJRTzBGQlJVVXNSVUZCUVN4UlFVRlJMRVZCUVVVc1UwRkdXanRCUVVkRkxFVkJRVUVzU1VGQlNTeEZRVU5HTzBGQlNrb3NRMEY2UW1Vc1JVRXJRbVk3UVVGRFJTeEZRVUZCTEVkQlFVY3NSVUZCUlN4M1FrRkVVRHRCUVVWRkxFVkJRVUVzVVVGQlVTeEZRVUZGTEZGQlJsbzdRVUZIUlN4RlFVRkJMRWxCUVVrc1JVRkRSanRCUVVwS0xFTkJMMEpsTEVWQmNVTm1PMEZCUTBVc1JVRkJRU3hIUVVGSExFVkJRVVVzZDBKQlJGQTdRVUZGUlN4RlFVRkJMRkZCUVZFc1JVRkJSU3hWUVVaYU8wRkJSMFVzUlVGQlFTeEpRVUZKTEVWQlEwWTdRVUZLU2l4RFFYSkRaU3hGUVRKRFpqdEJRVU5GTEVWQlFVRXNSMEZCUnl4RlFVRkZMSGRDUVVSUU8wRkJSVVVzUlVGQlFTeFJRVUZSTEVWQlFVVXNkVUpCUmxvN1FVRkhSU3hGUVVGQkxFbEJRVWtzUlVGRFJqdEJRVXBLTEVOQk0wTmxMRVZCYVVSbU8wRkJRMFVzUlVGQlFTeEhRVUZITEVWQlFVVXNkMEpCUkZBN1FVRkZSU3hGUVVGQkxGRkJRVkVzUlVGQlJTeHBRa0ZHV2p0QlFVZEZMRVZCUVVFc1NVRkJTU3hGUVVOR08wRkJTa29zUTBGcVJHVXNRMEZCYWtJN1FVRjVSRUVzVVVGQlVTeERRVUZETEdkQ1FVRlVMRU5CUVRCQ0xGRkJRVEZDTEVWQlFXOURMRmxCUVUwN1FVRkRlRU1zVFVGQlNTeE5RVUZOTEVOQlFVTXNWMEZCVUN4SFFVRnhRaXhQUVVGUExFTkJRVU1zV1VGQmFrTXNSVUZCSzBNN1FVRkROME1zU1VGQlFTeFBRVUZQTEVOQlFVTXNVMEZCVWl4RFFVRnJRaXhOUVVGc1FpeERRVUY1UWl4UFFVRjZRanRCUVVORUxFZEJSa1FzVFVGRlR6dEJRVU5NTEVsQlFVRXNUMEZCVHl4RFFVRkRMRk5CUVZJc1EwRkJhMElzUjBGQmJFSXNRMEZCYzBJc1QwRkJkRUk3UVVGRFJEdEJRVU5HTEVOQlRrUTdPMEZCVVVFc1RVRkJUU3hEUVVGRExFOUJRVkFzUjBGQmFVSXNWVUZCUVN4RFFVRkRMRVZCUVVrN1FVRkRjRUlzUlVGQlFTeERRVUZETEVOQlFVTXNZMEZCUmp0QlFVTkJMRVZCUVVFc1ZVRkJWU3hEUVVGRExGTkJRVmdzUTBGQmNVSXNUVUZCY2tJc1EwRkJORUlzVFVGQk5VSTdRVUZEUkN4RFFVaEVPenRCUVV0QkxGRkJRVkVzUTBGQlF5eFBRVUZVTEVkQlFXMUNMRlZCUVVFc1EwRkJReXhGUVVGSk8wRkJRM1JDTEVWQlFVRXNRMEZCUXl4RFFVRkRMR05CUVVZN1FVRkRRU3hGUVVGQkxGVkJRVlVzUTBGQlF5eFRRVUZZTEVOQlFYRkNMRTFCUVhKQ0xFTkJRVFJDTEUxQlFUVkNPMEZCUTBRc1EwRklSRHM3UVVGTFFTeFZRVUZWTEVOQlFVTXNUMEZCV0N4SFFVRnhRaXhaUVVGTk8wRkJRM3BDTEVWQlFVRXNWVUZCVlN4RFFVRkRMRk5CUVZnc1EwRkJjVUlzVFVGQmNrSXNRMEZCTkVJc1RVRkJOVUk3UVVGRFJDeERRVVpFT3p0QlFVMUJMRWxCUVUwc1kwRkJZeXhIUVVGSExGTkJRV3BDTEdOQlFXbENMRU5CUVVFc1NVRkJTU3hGUVVGSk8wRkJRemRDTERoSFFVVmpMRWxCUVVrc1EwRkJReXhIUVVadVFpd3dSMEZKY1VNc1NVRkJTU3hEUVVGRExGRkJTakZETEhORVFVdG5ReXhKUVVGSkxFTkJRVU1zU1VGTWNrTTdRVUZUUkN4RFFWWkVPenRCUVZsQkxFbEJRVWtzWVVGQllTeEhRVUZITEZOQlFXaENMR0ZCUVdkQ0xFTkJRVUVzV1VGQldTeEZRVUZKTzBGQlEyeERMRTFCUVUwc1VVRkJVU3hIUVVGSkxGbEJRVmtzUTBGQlF5eEhRVUZpTEVOQlFXbENMRlZCUVVFc1QwRkJUenRCUVVGQkxGZEJRVWtzWTBGQll5eERRVUZETEU5QlFVUXNRMEZCYkVJN1FVRkJRU3hIUVVGNFFpeERRVUZzUWp0QlFVTkJMRVZCUVVFc1VVRkJVU3hEUVVGRExHTkJRVlFzUTBGQmQwSXNaMEpCUVhoQ0xFVkJRVEJETEZOQlFURkRMRWRCUVhORUxGRkJRVkVzUTBGQlF5eEpRVUZVTEVOQlFXTXNSVUZCWkN4RFFVRjBSRHRCUVVORUxFTkJTRVE3TzBGQlMwRXNUMEZCVHl4RFFVRkRMRTlCUVZJc1IwRkJhMElzVlVGQlFTeERRVUZETEVWQlFVazdRVUZEY2tJc1JVRkJRU3hEUVVGRExFTkJRVU1zWTBGQlJqdEJRVU5CTEVWQlFVRXNUMEZCVHl4SlFVRkpMRU5CUVZnN1FVRkRRU3hGUVVGQkxHRkJRV0VzUTBGQlF5eFJRVUZSTEVOQlFVTXNTMEZCVkN4RFFVRmxMRU5CUVdZc1JVRkJhMElzVDBGQmJFSXNRMEZCUkN4RFFVRmlPMEZCUTBRc1EwRktSRHM3UVVGTlFTeE5RVUZOTEVOQlFVTXNaMEpCUVZBc1EwRkJkMElzYTBKQlFYaENMRVZCUVRSRExGbEJRVTA3UVVGRGFFUXNUVUZCVFN4WlFVRlpMRWRCUVVjc1UwRkJaaXhaUVVGbE8wRkJRVUU3UVVGQlFUdEJRVUZCTzBGQlFVRTdRVUZCUVN3d1FrRkRXQ3hKUVVSWE8wRkJRVUVzTkVOQlJWb3NVVUZCVVN4RFFVRkRMR1ZCUVZRc1EwRkJlVUlzVjBGQmVrSXNSMEZCZFVNc1IwRkdNMEk3UVVGQlFUczdRVUZCUVR0QlFVZG1MRmxCUVVFc1QwRkJUeXhIUVVGSExFTkJRVlk3UVVGSVpUczdRVUZCUVR0QlFVMW1MRmxCUVVFc1QwRkJUeXhIUVVGSExFTkJRVlk3UVVGT1pUczdRVUZCUVR0QlFVRkJPMEZCUVVFN1FVRkJRVHRCUVVGQk8wRkJRVUU3UVVGQlFTeEhRVUZ5UWpzN1FVRlZRU3hGUVVGQkxGbEJRVms3UVVGRFdpeEZRVUZCTEdGQlFXRXNRMEZCUXl4UlFVRlJMRU5CUVVNc1MwRkJWQ3hEUVVGbExFTkJRV1lzUlVGQmEwSXNUMEZCYkVJc1EwRkJSQ3hEUVVGaU8wRkJRMFFzUTBGaVJDSXNJbVpwYkdVaU9pSm5aVzVsY21GMFpXUXVhbk1pTENKemIzVnlZMlZTYjI5MElqb2lJaXdpYzI5MWNtTmxjME52Ym5SbGJuUWlPbHNpS0daMWJtTjBhVzl1S0NsN1puVnVZM1JwYjI0Z2NpaGxMRzRzZENsN1puVnVZM1JwYjI0Z2J5aHBMR1lwZTJsbUtDRnVXMmxkS1h0cFppZ2haVnRwWFNsN2RtRnlJR005WENKbWRXNWpkR2x2Ymx3aVBUMTBlWEJsYjJZZ2NtVnhkV2x5WlNZbWNtVnhkV2x5WlR0cFppZ2haaVltWXlseVpYUjFjbTRnWXlocExDRXdLVHRwWmloMUtYSmxkSFZ5YmlCMUtHa3NJVEFwTzNaaGNpQmhQVzVsZHlCRmNuSnZjaWhjSWtOaGJtNXZkQ0JtYVc1a0lHMXZaSFZzWlNBblhDSXJhU3RjSWlkY0lpazdkR2h5YjNjZ1lTNWpiMlJsUFZ3aVRVOUVWVXhGWDA1UFZGOUdUMVZPUkZ3aUxHRjlkbUZ5SUhBOWJsdHBYVDE3Wlhod2IzSjBjenA3ZlgwN1pWdHBYVnN3WFM1allXeHNLSEF1Wlhod2IzSjBjeXhtZFc1amRHbHZiaWh5S1h0MllYSWdiajFsVzJsZFd6RmRXM0pkTzNKbGRIVnliaUJ2S0c1OGZISXBmU3h3TEhBdVpYaHdiM0owY3l4eUxHVXNiaXgwS1gxeVpYUjFjbTRnYmx0cFhTNWxlSEJ2Y25SemZXWnZjaWgyWVhJZ2RUMWNJbVoxYm1OMGFXOXVYQ0k5UFhSNWNHVnZaaUJ5WlhGMWFYSmxKaVp5WlhGMWFYSmxMR2s5TUR0cFBIUXViR1Z1WjNSb08ya3JLeWx2S0hSYmFWMHBPM0psZEhWeWJpQnZmWEpsZEhWeWJpQnlmU2tvS1NJc0lpOHFLbHh1SUNvZ1EyOXdlWEpwWjJoMElDaGpLU0F5TURFMExYQnlaWE5sYm5Rc0lFWmhZMlZpYjI5ckxDQkpibU11WEc0Z0tseHVJQ29nVkdocGN5QnpiM1Z5WTJVZ1kyOWtaU0JwY3lCc2FXTmxibk5sWkNCMWJtUmxjaUIwYUdVZ1RVbFVJR3hwWTJWdWMyVWdabTkxYm1RZ2FXNGdkR2hsWEc0Z0tpQk1TVU5GVGxORklHWnBiR1VnYVc0Z2RHaGxJSEp2YjNRZ1pHbHlaV04wYjNKNUlHOW1JSFJvYVhNZ2MyOTFjbU5sSUhSeVpXVXVYRzRnS2k5Y2JseHVkbUZ5SUhKMWJuUnBiV1VnUFNBb1puVnVZM1JwYjI0Z0tHVjRjRzl5ZEhNcElIdGNiaUFnWENKMWMyVWdjM1J5YVdOMFhDSTdYRzVjYmlBZ2RtRnlJRTl3SUQwZ1QySnFaV04wTG5CeWIzUnZkSGx3WlR0Y2JpQWdkbUZ5SUdoaGMwOTNiaUE5SUU5d0xtaGhjMDkzYmxCeWIzQmxjblI1TzF4dUlDQjJZWElnZFc1a1pXWnBibVZrT3lBdkx5Qk5iM0psSUdOdmJYQnlaWE56YVdKc1pTQjBhR0Z1SUhadmFXUWdNQzVjYmlBZ2RtRnlJQ1JUZVcxaWIyd2dQU0IwZVhCbGIyWWdVM2x0WW05c0lEMDlQU0JjSW1aMWJtTjBhVzl1WENJZ1B5QlRlVzFpYjJ3Z09pQjdmVHRjYmlBZ2RtRnlJR2wwWlhKaGRHOXlVM2x0WW05c0lEMGdKRk41YldKdmJDNXBkR1Z5WVhSdmNpQjhmQ0JjSWtCQWFYUmxjbUYwYjNKY0lqdGNiaUFnZG1GeUlHRnplVzVqU1hSbGNtRjBiM0pUZVcxaWIyd2dQU0FrVTNsdFltOXNMbUZ6ZVc1alNYUmxjbUYwYjNJZ2ZId2dYQ0pBUUdGemVXNWpTWFJsY21GMGIzSmNJanRjYmlBZ2RtRnlJSFJ2VTNSeWFXNW5WR0ZuVTNsdFltOXNJRDBnSkZONWJXSnZiQzUwYjFOMGNtbHVaMVJoWnlCOGZDQmNJa0JBZEc5VGRISnBibWRVWVdkY0lqdGNibHh1SUNCbWRXNWpkR2x2YmlCM2NtRndLR2x1Ym1WeVJtNHNJRzkxZEdWeVJtNHNJSE5sYkdZc0lIUnllVXh2WTNOTWFYTjBLU0I3WEc0Z0lDQWdMeThnU1dZZ2IzVjBaWEpHYmlCd2NtOTJhV1JsWkNCaGJtUWdiM1YwWlhKR2JpNXdjbTkwYjNSNWNHVWdhWE1nWVNCSFpXNWxjbUYwYjNJc0lIUm9aVzRnYjNWMFpYSkdiaTV3Y205MGIzUjVjR1VnYVc1emRHRnVZMlZ2WmlCSFpXNWxjbUYwYjNJdVhHNGdJQ0FnZG1GeUlIQnliM1J2UjJWdVpYSmhkRzl5SUQwZ2IzVjBaWEpHYmlBbUppQnZkWFJsY2tadUxuQnliM1J2ZEhsd1pTQnBibk4wWVc1alpXOW1JRWRsYm1WeVlYUnZjaUEvSUc5MWRHVnlSbTRnT2lCSFpXNWxjbUYwYjNJN1hHNGdJQ0FnZG1GeUlHZGxibVZ5WVhSdmNpQTlJRTlpYW1WamRDNWpjbVZoZEdVb2NISnZkRzlIWlc1bGNtRjBiM0l1Y0hKdmRHOTBlWEJsS1R0Y2JpQWdJQ0IyWVhJZ1kyOXVkR1Y0ZENBOUlHNWxkeUJEYjI1MFpYaDBLSFJ5ZVV4dlkzTk1hWE4wSUh4OElGdGRLVHRjYmx4dUlDQWdJQzh2SUZSb1pTQXVYMmx1ZG05clpTQnRaWFJvYjJRZ2RXNXBabWxsY3lCMGFHVWdhVzF3YkdWdFpXNTBZWFJwYjI1eklHOW1JSFJvWlNBdWJtVjRkQ3hjYmlBZ0lDQXZMeUF1ZEdoeWIzY3NJR0Z1WkNBdWNtVjBkWEp1SUcxbGRHaHZaSE11WEc0Z0lDQWdaMlZ1WlhKaGRHOXlMbDlwYm5admEyVWdQU0J0WVd0bFNXNTJiMnRsVFdWMGFHOWtLR2x1Ym1WeVJtNHNJSE5sYkdZc0lHTnZiblJsZUhRcE8xeHVYRzRnSUNBZ2NtVjBkWEp1SUdkbGJtVnlZWFJ2Y2p0Y2JpQWdmVnh1SUNCbGVIQnZjblJ6TG5keVlYQWdQU0IzY21Gd08xeHVYRzRnSUM4dklGUnllUzlqWVhSamFDQm9aV3h3WlhJZ2RHOGdiV2x1YVcxcGVtVWdaR1Z2Y0hScGJXbDZZWFJwYjI1ekxpQlNaWFIxY201eklHRWdZMjl0Y0d4bGRHbHZibHh1SUNBdkx5QnlaV052Y21RZ2JHbHJaU0JqYjI1MFpYaDBMblJ5ZVVWdWRISnBaWE5iYVYwdVkyOXRjR3hsZEdsdmJpNGdWR2hwY3lCcGJuUmxjbVpoWTJVZ1kyOTFiR1JjYmlBZ0x5OGdhR0YyWlNCaVpXVnVJQ2hoYm1RZ2QyRnpJSEJ5WlhacGIzVnpiSGtwSUdSbGMybG5ibVZrSUhSdklIUmhhMlVnWVNCamJHOXpkWEpsSUhSdklHSmxYRzRnSUM4dklHbHVkbTlyWldRZ2QybDBhRzkxZENCaGNtZDFiV1Z1ZEhNc0lHSjFkQ0JwYmlCaGJHd2dkR2hsSUdOaGMyVnpJSGRsSUdOaGNtVWdZV0p2ZFhRZ2QyVmNiaUFnTHk4Z1lXeHlaV0ZrZVNCb1lYWmxJR0Z1SUdWNGFYTjBhVzVuSUcxbGRHaHZaQ0IzWlNCM1lXNTBJSFJ2SUdOaGJHd3NJSE52SUhSb1pYSmxKM01nYm04Z2JtVmxaRnh1SUNBdkx5QjBieUJqY21WaGRHVWdZU0J1WlhjZ1puVnVZM1JwYjI0Z2IySnFaV04wTGlCWFpTQmpZVzRnWlhabGJpQm5aWFFnWVhkaGVTQjNhWFJvSUdGemMzVnRhVzVuWEc0Z0lDOHZJSFJvWlNCdFpYUm9iMlFnZEdGclpYTWdaWGhoWTNSc2VTQnZibVVnWVhKbmRXMWxiblFzSUhOcGJtTmxJSFJvWVhRZ2FHRndjR1Z1Y3lCMGJ5QmlaU0IwY25WbFhHNGdJQzh2SUdsdUlHVjJaWEo1SUdOaGMyVXNJSE52SUhkbElHUnZiaWQwSUdoaGRtVWdkRzhnZEc5MVkyZ2dkR2hsSUdGeVozVnRaVzUwY3lCdlltcGxZM1F1SUZSb1pWeHVJQ0F2THlCdmJteDVJR0ZrWkdsMGFXOXVZV3dnWVd4c2IyTmhkR2x2YmlCeVpYRjFhWEpsWkNCcGN5QjBhR1VnWTI5dGNHeGxkR2x2YmlCeVpXTnZjbVFzSUhkb2FXTm9YRzRnSUM4dklHaGhjeUJoSUhOMFlXSnNaU0J6YUdGd1pTQmhibVFnYzI4Z2FHOXdaV1oxYkd4NUlITm9iM1ZzWkNCaVpTQmphR1ZoY0NCMGJ5QmhiR3h2WTJGMFpTNWNiaUFnWm5WdVkzUnBiMjRnZEhKNVEyRjBZMmdvWm00c0lHOWlhaXdnWVhKbktTQjdYRzRnSUNBZ2RISjVJSHRjYmlBZ0lDQWdJSEpsZEhWeWJpQjdJSFI1Y0dVNklGd2libTl5YldGc1hDSXNJR0Z5WnpvZ1ptNHVZMkZzYkNodlltb3NJR0Z5WnlrZ2ZUdGNiaUFnSUNCOUlHTmhkR05vSUNobGNuSXBJSHRjYmlBZ0lDQWdJSEpsZEhWeWJpQjdJSFI1Y0dVNklGd2lkR2h5YjNkY0lpd2dZWEpuT2lCbGNuSWdmVHRjYmlBZ0lDQjlYRzRnSUgxY2JseHVJQ0IyWVhJZ1IyVnVVM1JoZEdWVGRYTndaVzVrWldSVGRHRnlkQ0E5SUZ3aWMzVnpjR1Z1WkdWa1UzUmhjblJjSWp0Y2JpQWdkbUZ5SUVkbGJsTjBZWFJsVTNWemNHVnVaR1ZrV1dsbGJHUWdQU0JjSW5OMWMzQmxibVJsWkZscFpXeGtYQ0k3WEc0Z0lIWmhjaUJIWlc1VGRHRjBaVVY0WldOMWRHbHVaeUE5SUZ3aVpYaGxZM1YwYVc1blhDSTdYRzRnSUhaaGNpQkhaVzVUZEdGMFpVTnZiWEJzWlhSbFpDQTlJRndpWTI5dGNHeGxkR1ZrWENJN1hHNWNiaUFnTHk4Z1VtVjBkWEp1YVc1bklIUm9hWE1nYjJKcVpXTjBJR1p5YjIwZ2RHaGxJR2x1Ym1WeVJtNGdhR0Z6SUhSb1pTQnpZVzFsSUdWbVptVmpkQ0JoYzF4dUlDQXZMeUJpY21WaGEybHVaeUJ2ZFhRZ2IyWWdkR2hsSUdScGMzQmhkR05vSUhOM2FYUmphQ0J6ZEdGMFpXMWxiblF1WEc0Z0lIWmhjaUJEYjI1MGFXNTFaVk5sYm5ScGJtVnNJRDBnZTMwN1hHNWNiaUFnTHk4Z1JIVnRiWGtnWTI5dWMzUnlkV04wYjNJZ1puVnVZM1JwYjI1eklIUm9ZWFFnZDJVZ2RYTmxJR0Z6SUhSb1pTQXVZMjl1YzNSeWRXTjBiM0lnWVc1a1hHNGdJQzh2SUM1amIyNXpkSEoxWTNSdmNpNXdjbTkwYjNSNWNHVWdjSEp2Y0dWeWRHbGxjeUJtYjNJZ1puVnVZM1JwYjI1eklIUm9ZWFFnY21WMGRYSnVJRWRsYm1WeVlYUnZjbHh1SUNBdkx5QnZZbXBsWTNSekxpQkdiM0lnWm5Wc2JDQnpjR1ZqSUdOdmJYQnNhV0Z1WTJVc0lIbHZkU0J0WVhrZ2QybHphQ0IwYnlCamIyNW1hV2QxY21VZ2VXOTFjbHh1SUNBdkx5QnRhVzVwWm1sbGNpQnViM1FnZEc4Z2JXRnVaMnhsSUhSb1pTQnVZVzFsY3lCdlppQjBhR1Z6WlNCMGQyOGdablZ1WTNScGIyNXpMbHh1SUNCbWRXNWpkR2x2YmlCSFpXNWxjbUYwYjNJb0tTQjdmVnh1SUNCbWRXNWpkR2x2YmlCSFpXNWxjbUYwYjNKR2RXNWpkR2x2YmlncElIdDlYRzRnSUdaMWJtTjBhVzl1SUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1VUhKdmRHOTBlWEJsS0NrZ2UzMWNibHh1SUNBdkx5QlVhR2x6SUdseklHRWdjRzlzZVdacGJHd2dabTl5SUNWSmRHVnlZWFJ2Y2xCeWIzUnZkSGx3WlNVZ1ptOXlJR1Z1ZG1seWIyNXRaVzUwY3lCMGFHRjBYRzRnSUM4dklHUnZiaWQwSUc1aGRHbDJaV3g1SUhOMWNIQnZjblFnYVhRdVhHNGdJSFpoY2lCSmRHVnlZWFJ2Y2xCeWIzUnZkSGx3WlNBOUlIdDlPMXh1SUNCSmRHVnlZWFJ2Y2xCeWIzUnZkSGx3WlZ0cGRHVnlZWFJ2Y2xONWJXSnZiRjBnUFNCbWRXNWpkR2x2YmlBb0tTQjdYRzRnSUNBZ2NtVjBkWEp1SUhSb2FYTTdYRzRnSUgwN1hHNWNiaUFnZG1GeUlHZGxkRkJ5YjNSdklEMGdUMkpxWldOMExtZGxkRkJ5YjNSdmRIbHdaVTltTzF4dUlDQjJZWElnVG1GMGFYWmxTWFJsY21GMGIzSlFjbTkwYjNSNWNHVWdQU0JuWlhSUWNtOTBieUFtSmlCblpYUlFjbTkwYnloblpYUlFjbTkwYnloMllXeDFaWE1vVzEwcEtTazdYRzRnSUdsbUlDaE9ZWFJwZG1WSmRHVnlZWFJ2Y2xCeWIzUnZkSGx3WlNBbUpseHVJQ0FnSUNBZ1RtRjBhWFpsU1hSbGNtRjBiM0pRY205MGIzUjVjR1VnSVQwOUlFOXdJQ1ltWEc0Z0lDQWdJQ0JvWVhOUGQyNHVZMkZzYkNoT1lYUnBkbVZKZEdWeVlYUnZjbEJ5YjNSdmRIbHdaU3dnYVhSbGNtRjBiM0pUZVcxaWIyd3BLU0I3WEc0Z0lDQWdMeThnVkdocGN5QmxiblpwY205dWJXVnVkQ0JvWVhNZ1lTQnVZWFJwZG1VZ0pVbDBaWEpoZEc5eVVISnZkRzkwZVhCbEpUc2dkWE5sSUdsMElHbHVjM1JsWVdSY2JpQWdJQ0F2THlCdlppQjBhR1VnY0c5c2VXWnBiR3d1WEc0Z0lDQWdTWFJsY21GMGIzSlFjbTkwYjNSNWNHVWdQU0JPWVhScGRtVkpkR1Z5WVhSdmNsQnliM1J2ZEhsd1pUdGNiaUFnZlZ4dVhHNGdJSFpoY2lCSGNDQTlJRWRsYm1WeVlYUnZja1oxYm1OMGFXOXVVSEp2ZEc5MGVYQmxMbkJ5YjNSdmRIbHdaU0E5WEc0Z0lDQWdSMlZ1WlhKaGRHOXlMbkJ5YjNSdmRIbHdaU0E5SUU5aWFtVmpkQzVqY21WaGRHVW9TWFJsY21GMGIzSlFjbTkwYjNSNWNHVXBPMXh1SUNCSFpXNWxjbUYwYjNKR2RXNWpkR2x2Ymk1d2NtOTBiM1I1Y0dVZ1BTQkhjQzVqYjI1emRISjFZM1J2Y2lBOUlFZGxibVZ5WVhSdmNrWjFibU4wYVc5dVVISnZkRzkwZVhCbE8xeHVJQ0JIWlc1bGNtRjBiM0pHZFc1amRHbHZibEJ5YjNSdmRIbHdaUzVqYjI1emRISjFZM1J2Y2lBOUlFZGxibVZ5WVhSdmNrWjFibU4wYVc5dU8xeHVJQ0JIWlc1bGNtRjBiM0pHZFc1amRHbHZibEJ5YjNSdmRIbHdaVnQwYjFOMGNtbHVaMVJoWjFONWJXSnZiRjBnUFZ4dUlDQWdJRWRsYm1WeVlYUnZja1oxYm1OMGFXOXVMbVJwYzNCc1lYbE9ZVzFsSUQwZ1hDSkhaVzVsY21GMGIzSkdkVzVqZEdsdmJsd2lPMXh1WEc0Z0lDOHZJRWhsYkhCbGNpQm1iM0lnWkdWbWFXNXBibWNnZEdobElDNXVaWGgwTENBdWRHaHliM2NzSUdGdVpDQXVjbVYwZFhKdUlHMWxkR2h2WkhNZ2IyWWdkR2hsWEc0Z0lDOHZJRWwwWlhKaGRHOXlJR2x1ZEdWeVptRmpaU0JwYmlCMFpYSnRjeUJ2WmlCaElITnBibWRzWlNBdVgybHVkbTlyWlNCdFpYUm9iMlF1WEc0Z0lHWjFibU4wYVc5dUlHUmxabWx1WlVsMFpYSmhkRzl5VFdWMGFHOWtjeWh3Y205MGIzUjVjR1VwSUh0Y2JpQWdJQ0JiWENKdVpYaDBYQ0lzSUZ3aWRHaHliM2RjSWl3Z1hDSnlaWFIxY201Y0lsMHVabTl5UldGamFDaG1kVzVqZEdsdmJpaHRaWFJvYjJRcElIdGNiaUFnSUNBZ0lIQnliM1J2ZEhsd1pWdHRaWFJvYjJSZElEMGdablZ1WTNScGIyNG9ZWEpuS1NCN1hHNGdJQ0FnSUNBZ0lISmxkSFZ5YmlCMGFHbHpMbDlwYm5admEyVW9iV1YwYUc5a0xDQmhjbWNwTzF4dUlDQWdJQ0FnZlR0Y2JpQWdJQ0I5S1R0Y2JpQWdmVnh1WEc0Z0lHVjRjRzl5ZEhNdWFYTkhaVzVsY21GMGIzSkdkVzVqZEdsdmJpQTlJR1oxYm1OMGFXOXVLR2RsYmtaMWJpa2dlMXh1SUNBZ0lIWmhjaUJqZEc5eUlEMGdkSGx3Wlc5bUlHZGxia1oxYmlBOVBUMGdYQ0ptZFc1amRHbHZibHdpSUNZbUlHZGxia1oxYmk1amIyNXpkSEoxWTNSdmNqdGNiaUFnSUNCeVpYUjFjbTRnWTNSdmNseHVJQ0FnSUNBZ1B5QmpkRzl5SUQwOVBTQkhaVzVsY21GMGIzSkdkVzVqZEdsdmJpQjhmRnh1SUNBZ0lDQWdJQ0F2THlCR2IzSWdkR2hsSUc1aGRHbDJaU0JIWlc1bGNtRjBiM0pHZFc1amRHbHZiaUJqYjI1emRISjFZM1J2Y2l3Z2RHaGxJR0psYzNRZ2QyVWdZMkZ1WEc0Z0lDQWdJQ0FnSUM4dklHUnZJR2x6SUhSdklHTm9aV05ySUdsMGN5QXVibUZ0WlNCd2NtOXdaWEowZVM1Y2JpQWdJQ0FnSUNBZ0tHTjBiM0l1WkdsemNHeGhlVTVoYldVZ2ZId2dZM1J2Y2k1dVlXMWxLU0E5UFQwZ1hDSkhaVzVsY21GMGIzSkdkVzVqZEdsdmJsd2lYRzRnSUNBZ0lDQTZJR1poYkhObE8xeHVJQ0I5TzF4dVhHNGdJR1Y0Y0c5eWRITXViV0Z5YXlBOUlHWjFibU4wYVc5dUtHZGxia1oxYmlrZ2UxeHVJQ0FnSUdsbUlDaFBZbXBsWTNRdWMyVjBVSEp2ZEc5MGVYQmxUMllwSUh0Y2JpQWdJQ0FnSUU5aWFtVmpkQzV6WlhSUWNtOTBiM1I1Y0dWUFppaG5aVzVHZFc0c0lFZGxibVZ5WVhSdmNrWjFibU4wYVc5dVVISnZkRzkwZVhCbEtUdGNiaUFnSUNCOUlHVnNjMlVnZTF4dUlDQWdJQ0FnWjJWdVJuVnVMbDlmY0hKdmRHOWZYeUE5SUVkbGJtVnlZWFJ2Y2taMWJtTjBhVzl1VUhKdmRHOTBlWEJsTzF4dUlDQWdJQ0FnYVdZZ0tDRW9kRzlUZEhKcGJtZFVZV2RUZVcxaWIyd2dhVzRnWjJWdVJuVnVLU2tnZTF4dUlDQWdJQ0FnSUNCblpXNUdkVzViZEc5VGRISnBibWRVWVdkVGVXMWliMnhkSUQwZ1hDSkhaVzVsY21GMGIzSkdkVzVqZEdsdmJsd2lPMXh1SUNBZ0lDQWdmVnh1SUNBZ0lIMWNiaUFnSUNCblpXNUdkVzR1Y0hKdmRHOTBlWEJsSUQwZ1QySnFaV04wTG1OeVpXRjBaU2hIY0NrN1hHNGdJQ0FnY21WMGRYSnVJR2RsYmtaMWJqdGNiaUFnZlR0Y2JseHVJQ0F2THlCWGFYUm9hVzRnZEdobElHSnZaSGtnYjJZZ1lXNTVJR0Z6ZVc1aklHWjFibU4wYVc5dUxDQmdZWGRoYVhRZ2VHQWdhWE1nZEhKaGJuTm1iM0p0WldRZ2RHOWNiaUFnTHk4Z1lIbHBaV3hrSUhKbFoyVnVaWEpoZEc5eVVuVnVkR2x0WlM1aGQzSmhjQ2g0S1dBc0lITnZJSFJvWVhRZ2RHaGxJSEoxYm5ScGJXVWdZMkZ1SUhSbGMzUmNiaUFnTHk4Z1lHaGhjMDkzYmk1allXeHNLSFpoYkhWbExDQmNJbDlmWVhkaGFYUmNJaWxnSUhSdklHUmxkR1Z5YldsdVpTQnBaaUIwYUdVZ2VXbGxiR1JsWkNCMllXeDFaU0JwYzF4dUlDQXZMeUJ0WldGdWRDQjBieUJpWlNCaGQyRnBkR1ZrTGx4dUlDQmxlSEJ2Y25SekxtRjNjbUZ3SUQwZ1puVnVZM1JwYjI0b1lYSm5LU0I3WEc0Z0lDQWdjbVYwZFhKdUlIc2dYMTloZDJGcGREb2dZWEpuSUgwN1hHNGdJSDA3WEc1Y2JpQWdablZ1WTNScGIyNGdRWE41Ym1OSmRHVnlZWFJ2Y2loblpXNWxjbUYwYjNJcElIdGNiaUFnSUNCbWRXNWpkR2x2YmlCcGJuWnZhMlVvYldWMGFHOWtMQ0JoY21jc0lISmxjMjlzZG1Vc0lISmxhbVZqZENrZ2UxeHVJQ0FnSUNBZ2RtRnlJSEpsWTI5eVpDQTlJSFJ5ZVVOaGRHTm9LR2RsYm1WeVlYUnZjbHR0WlhSb2IyUmRMQ0JuWlc1bGNtRjBiM0lzSUdGeVp5azdYRzRnSUNBZ0lDQnBaaUFvY21WamIzSmtMblI1Y0dVZ1BUMDlJRndpZEdoeWIzZGNJaWtnZTF4dUlDQWdJQ0FnSUNCeVpXcGxZM1FvY21WamIzSmtMbUZ5WnlrN1hHNGdJQ0FnSUNCOUlHVnNjMlVnZTF4dUlDQWdJQ0FnSUNCMllYSWdjbVZ6ZFd4MElEMGdjbVZqYjNKa0xtRnlaenRjYmlBZ0lDQWdJQ0FnZG1GeUlIWmhiSFZsSUQwZ2NtVnpkV3gwTG5aaGJIVmxPMXh1SUNBZ0lDQWdJQ0JwWmlBb2RtRnNkV1VnSmlaY2JpQWdJQ0FnSUNBZ0lDQWdJSFI1Y0dWdlppQjJZV3gxWlNBOVBUMGdYQ0p2WW1wbFkzUmNJaUFtSmx4dUlDQWdJQ0FnSUNBZ0lDQWdhR0Z6VDNkdUxtTmhiR3dvZG1Gc2RXVXNJRndpWDE5aGQyRnBkRndpS1NrZ2UxeHVJQ0FnSUNBZ0lDQWdJSEpsZEhWeWJpQlFjbTl0YVhObExuSmxjMjlzZG1Vb2RtRnNkV1V1WDE5aGQyRnBkQ2t1ZEdobGJpaG1kVzVqZEdsdmJpaDJZV3gxWlNrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnYVc1MmIydGxLRndpYm1WNGRGd2lMQ0IyWVd4MVpTd2djbVZ6YjJ4MlpTd2djbVZxWldOMEtUdGNiaUFnSUNBZ0lDQWdJQ0I5TENCbWRXNWpkR2x2YmlobGNuSXBJSHRjYmlBZ0lDQWdJQ0FnSUNBZ0lHbHVkbTlyWlNoY0luUm9jbTkzWENJc0lHVnljaXdnY21WemIyeDJaU3dnY21WcVpXTjBLVHRjYmlBZ0lDQWdJQ0FnSUNCOUtUdGNiaUFnSUNBZ0lDQWdmVnh1WEc0Z0lDQWdJQ0FnSUhKbGRIVnliaUJRY205dGFYTmxMbkpsYzI5c2RtVW9kbUZzZFdVcExuUm9aVzRvWm5WdVkzUnBiMjRvZFc1M2NtRndjR1ZrS1NCN1hHNGdJQ0FnSUNBZ0lDQWdMeThnVjJobGJpQmhJSGxwWld4a1pXUWdVSEp2YldselpTQnBjeUJ5WlhOdmJIWmxaQ3dnYVhSeklHWnBibUZzSUhaaGJIVmxJR0psWTI5dFpYTmNiaUFnSUNBZ0lDQWdJQ0F2THlCMGFHVWdMblpoYkhWbElHOW1JSFJvWlNCUWNtOXRhWE5sUEh0MllXeDFaU3hrYjI1bGZUNGdjbVZ6ZFd4MElHWnZjaUIwYUdWY2JpQWdJQ0FnSUNBZ0lDQXZMeUJqZFhKeVpXNTBJR2wwWlhKaGRHbHZiaTVjYmlBZ0lDQWdJQ0FnSUNCeVpYTjFiSFF1ZG1Gc2RXVWdQU0IxYm5keVlYQndaV1E3WEc0Z0lDQWdJQ0FnSUNBZ2NtVnpiMngyWlNoeVpYTjFiSFFwTzF4dUlDQWdJQ0FnSUNCOUxDQm1kVzVqZEdsdmJpaGxjbkp2Y2lrZ2UxeHVJQ0FnSUNBZ0lDQWdJQzh2SUVsbUlHRWdjbVZxWldOMFpXUWdVSEp2YldselpTQjNZWE1nZVdsbGJHUmxaQ3dnZEdoeWIzY2dkR2hsSUhKbGFtVmpkR2x2YmlCaVlXTnJYRzRnSUNBZ0lDQWdJQ0FnTHk4Z2FXNTBieUIwYUdVZ1lYTjVibU1nWjJWdVpYSmhkRzl5SUdaMWJtTjBhVzl1SUhOdklHbDBJR05oYmlCaVpTQm9ZVzVrYkdWa0lIUm9aWEpsTGx4dUlDQWdJQ0FnSUNBZ0lISmxkSFZ5YmlCcGJuWnZhMlVvWENKMGFISnZkMXdpTENCbGNuSnZjaXdnY21WemIyeDJaU3dnY21WcVpXTjBLVHRjYmlBZ0lDQWdJQ0FnZlNrN1hHNGdJQ0FnSUNCOVhHNGdJQ0FnZlZ4dVhHNGdJQ0FnZG1GeUlIQnlaWFpwYjNWelVISnZiV2x6WlR0Y2JseHVJQ0FnSUdaMWJtTjBhVzl1SUdWdWNYVmxkV1VvYldWMGFHOWtMQ0JoY21jcElIdGNiaUFnSUNBZ0lHWjFibU4wYVc5dUlHTmhiR3hKYm5admEyVlhhWFJvVFdWMGFHOWtRVzVrUVhKbktDa2dlMXh1SUNBZ0lDQWdJQ0J5WlhSMWNtNGdibVYzSUZCeWIyMXBjMlVvWm5WdVkzUnBiMjRvY21WemIyeDJaU3dnY21WcVpXTjBLU0I3WEc0Z0lDQWdJQ0FnSUNBZ2FXNTJiMnRsS0cxbGRHaHZaQ3dnWVhKbkxDQnlaWE52YkhabExDQnlaV3BsWTNRcE8xeHVJQ0FnSUNBZ0lDQjlLVHRjYmlBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnY21WMGRYSnVJSEJ5WlhacGIzVnpVSEp2YldselpTQTlYRzRnSUNBZ0lDQWdJQzh2SUVsbUlHVnVjWFZsZFdVZ2FHRnpJR0psWlc0Z1kyRnNiR1ZrSUdKbFptOXlaU3dnZEdobGJpQjNaU0IzWVc1MElIUnZJSGRoYVhRZ2RXNTBhV3hjYmlBZ0lDQWdJQ0FnTHk4Z1lXeHNJSEJ5WlhacGIzVnpJRkJ5YjIxcGMyVnpJR2hoZG1VZ1ltVmxiaUJ5WlhOdmJIWmxaQ0JpWldadmNtVWdZMkZzYkdsdVp5QnBiblp2YTJVc1hHNGdJQ0FnSUNBZ0lDOHZJSE52SUhSb1lYUWdjbVZ6ZFd4MGN5QmhjbVVnWVd4M1lYbHpJR1JsYkdsMlpYSmxaQ0JwYmlCMGFHVWdZMjl5Y21WamRDQnZjbVJsY2k0Z1NXWmNiaUFnSUNBZ0lDQWdMeThnWlc1eGRXVjFaU0JvWVhNZ2JtOTBJR0psWlc0Z1kyRnNiR1ZrSUdKbFptOXlaU3dnZEdobGJpQnBkQ0JwY3lCcGJYQnZjblJoYm5RZ2RHOWNiaUFnSUNBZ0lDQWdMeThnWTJGc2JDQnBiblp2YTJVZ2FXMXRaV1JwWVhSbGJIa3NJSGRwZEdodmRYUWdkMkZwZEdsdVp5QnZiaUJoSUdOaGJHeGlZV05ySUhSdklHWnBjbVVzWEc0Z0lDQWdJQ0FnSUM4dklITnZJSFJvWVhRZ2RHaGxJR0Z6ZVc1aklHZGxibVZ5WVhSdmNpQm1kVzVqZEdsdmJpQm9ZWE1nZEdobElHOXdjRzl5ZEhWdWFYUjVJSFJ2SUdSdlhHNGdJQ0FnSUNBZ0lDOHZJR0Z1ZVNCdVpXTmxjM05oY25rZ2MyVjBkWEFnYVc0Z1lTQndjbVZrYVdOMFlXSnNaU0IzWVhrdUlGUm9hWE1nY0hKbFpHbGpkR0ZpYVd4cGRIbGNiaUFnSUNBZ0lDQWdMeThnYVhNZ2QyaDVJSFJvWlNCUWNtOXRhWE5sSUdOdmJuTjBjblZqZEc5eUlITjVibU5vY205dWIzVnpiSGtnYVc1MmIydGxjeUJwZEhOY2JpQWdJQ0FnSUNBZ0x5OGdaWGhsWTNWMGIzSWdZMkZzYkdKaFkyc3NJR0Z1WkNCM2FIa2dZWE41Ym1NZ1puVnVZM1JwYjI1eklITjVibU5vY205dWIzVnpiSGxjYmlBZ0lDQWdJQ0FnTHk4Z1pYaGxZM1YwWlNCamIyUmxJR0psWm05eVpTQjBhR1VnWm1seWMzUWdZWGRoYVhRdUlGTnBibU5sSUhkbElHbHRjR3hsYldWdWRDQnphVzF3YkdWY2JpQWdJQ0FnSUNBZ0x5OGdZWE41Ym1NZ1puVnVZM1JwYjI1eklHbHVJSFJsY20xeklHOW1JR0Z6ZVc1aklHZGxibVZ5WVhSdmNuTXNJR2wwSUdseklHVnpjR1ZqYVdGc2JIbGNiaUFnSUNBZ0lDQWdMeThnYVcxd2IzSjBZVzUwSUhSdklHZGxkQ0IwYUdseklISnBaMmgwTENCbGRtVnVJSFJvYjNWbmFDQnBkQ0J5WlhGMWFYSmxjeUJqWVhKbExseHVJQ0FnSUNBZ0lDQndjbVYyYVc5MWMxQnliMjFwYzJVZ1B5QndjbVYyYVc5MWMxQnliMjFwYzJVdWRHaGxiaWhjYmlBZ0lDQWdJQ0FnSUNCallXeHNTVzUyYjJ0bFYybDBhRTFsZEdodlpFRnVaRUZ5Wnl4Y2JpQWdJQ0FnSUNBZ0lDQXZMeUJCZG05cFpDQndjbTl3WVdkaGRHbHVaeUJtWVdsc2RYSmxjeUIwYnlCUWNtOXRhWE5sY3lCeVpYUjFjbTVsWkNCaWVTQnNZWFJsY2x4dUlDQWdJQ0FnSUNBZ0lDOHZJR2x1ZG05allYUnBiMjV6SUc5bUlIUm9aU0JwZEdWeVlYUnZjaTVjYmlBZ0lDQWdJQ0FnSUNCallXeHNTVzUyYjJ0bFYybDBhRTFsZEdodlpFRnVaRUZ5WjF4dUlDQWdJQ0FnSUNBcElEb2dZMkZzYkVsdWRtOXJaVmRwZEdoTlpYUm9iMlJCYm1SQmNtY29LVHRjYmlBZ0lDQjlYRzVjYmlBZ0lDQXZMeUJFWldacGJtVWdkR2hsSUhWdWFXWnBaV1FnYUdWc2NHVnlJRzFsZEdodlpDQjBhR0YwSUdseklIVnpaV1FnZEc4Z2FXMXdiR1Z0Wlc1MElDNXVaWGgwTEZ4dUlDQWdJQzh2SUM1MGFISnZkeXdnWVc1a0lDNXlaWFIxY200Z0tITmxaU0JrWldacGJtVkpkR1Z5WVhSdmNrMWxkR2h2WkhNcExseHVJQ0FnSUhSb2FYTXVYMmx1ZG05clpTQTlJR1Z1Y1hWbGRXVTdYRzRnSUgxY2JseHVJQ0JrWldacGJtVkpkR1Z5WVhSdmNrMWxkR2h2WkhNb1FYTjVibU5KZEdWeVlYUnZjaTV3Y205MGIzUjVjR1VwTzF4dUlDQkJjM2x1WTBsMFpYSmhkRzl5TG5CeWIzUnZkSGx3WlZ0aGMzbHVZMGwwWlhKaGRHOXlVM2x0WW05c1hTQTlJR1oxYm1OMGFXOXVJQ2dwSUh0Y2JpQWdJQ0J5WlhSMWNtNGdkR2hwY3p0Y2JpQWdmVHRjYmlBZ1pYaHdiM0owY3k1QmMzbHVZMGwwWlhKaGRHOXlJRDBnUVhONWJtTkpkR1Z5WVhSdmNqdGNibHh1SUNBdkx5Qk9iM1JsSUhSb1lYUWdjMmx0Y0d4bElHRnplVzVqSUdaMWJtTjBhVzl1Y3lCaGNtVWdhVzF3YkdWdFpXNTBaV1FnYjI0Z2RHOXdJRzltWEc0Z0lDOHZJRUZ6ZVc1alNYUmxjbUYwYjNJZ2IySnFaV04wY3pzZ2RHaGxlU0JxZFhOMElISmxkSFZ5YmlCaElGQnliMjFwYzJVZ1ptOXlJSFJvWlNCMllXeDFaU0J2Wmx4dUlDQXZMeUIwYUdVZ1ptbHVZV3dnY21WemRXeDBJSEJ5YjJSMVkyVmtJR0o1SUhSb1pTQnBkR1Z5WVhSdmNpNWNiaUFnWlhod2IzSjBjeTVoYzNsdVl5QTlJR1oxYm1OMGFXOXVLR2x1Ym1WeVJtNHNJRzkxZEdWeVJtNHNJSE5sYkdZc0lIUnllVXh2WTNOTWFYTjBLU0I3WEc0Z0lDQWdkbUZ5SUdsMFpYSWdQU0J1WlhjZ1FYTjVibU5KZEdWeVlYUnZjaWhjYmlBZ0lDQWdJSGR5WVhBb2FXNXVaWEpHYml3Z2IzVjBaWEpHYml3Z2MyVnNaaXdnZEhKNVRHOWpjMHhwYzNRcFhHNGdJQ0FnS1R0Y2JseHVJQ0FnSUhKbGRIVnliaUJsZUhCdmNuUnpMbWx6UjJWdVpYSmhkRzl5Um5WdVkzUnBiMjRvYjNWMFpYSkdiaWxjYmlBZ0lDQWdJRDhnYVhSbGNpQXZMeUJKWmlCdmRYUmxja1p1SUdseklHRWdaMlZ1WlhKaGRHOXlMQ0J5WlhSMWNtNGdkR2hsSUdaMWJHd2dhWFJsY21GMGIzSXVYRzRnSUNBZ0lDQTZJR2wwWlhJdWJtVjRkQ2dwTG5Sb1pXNG9ablZ1WTNScGIyNG9jbVZ6ZFd4MEtTQjdYRzRnSUNBZ0lDQWdJQ0FnY21WMGRYSnVJSEpsYzNWc2RDNWtiMjVsSUQ4Z2NtVnpkV3gwTG5aaGJIVmxJRG9nYVhSbGNpNXVaWGgwS0NrN1hHNGdJQ0FnSUNBZ0lIMHBPMXh1SUNCOU8xeHVYRzRnSUdaMWJtTjBhVzl1SUcxaGEyVkpiblp2YTJWTlpYUm9iMlFvYVc1dVpYSkdiaXdnYzJWc1ppd2dZMjl1ZEdWNGRDa2dlMXh1SUNBZ0lIWmhjaUJ6ZEdGMFpTQTlJRWRsYmxOMFlYUmxVM1Z6Y0dWdVpHVmtVM1JoY25RN1hHNWNiaUFnSUNCeVpYUjFjbTRnWm5WdVkzUnBiMjRnYVc1MmIydGxLRzFsZEdodlpDd2dZWEpuS1NCN1hHNGdJQ0FnSUNCcFppQW9jM1JoZEdVZ1BUMDlJRWRsYmxOMFlYUmxSWGhsWTNWMGFXNW5LU0I3WEc0Z0lDQWdJQ0FnSUhSb2NtOTNJRzVsZHlCRmNuSnZjaWhjSWtkbGJtVnlZWFJ2Y2lCcGN5QmhiSEpsWVdSNUlISjFibTVwYm1kY0lpazdYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJR2xtSUNoemRHRjBaU0E5UFQwZ1IyVnVVM1JoZEdWRGIyMXdiR1YwWldRcElIdGNiaUFnSUNBZ0lDQWdhV1lnS0cxbGRHaHZaQ0E5UFQwZ1hDSjBhSEp2ZDF3aUtTQjdYRzRnSUNBZ0lDQWdJQ0FnZEdoeWIzY2dZWEpuTzF4dUlDQWdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lDQWdMeThnUW1VZ1ptOXlaMmwyYVc1bkxDQndaWElnTWpVdU15NHpMak11TXlCdlppQjBhR1VnYzNCbFl6cGNiaUFnSUNBZ0lDQWdMeThnYUhSMGNITTZMeTl3Wlc5d2JHVXViVzk2YVd4c1lTNXZjbWN2Zm1wdmNtVnVaRzl5Wm1ZdlpYTTJMV1J5WVdaMExtaDBiV3dqYzJWakxXZGxibVZ5WVhSdmNuSmxjM1Z0WlZ4dUlDQWdJQ0FnSUNCeVpYUjFjbTRnWkc5dVpWSmxjM1ZzZENncE8xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQmpiMjUwWlhoMExtMWxkR2h2WkNBOUlHMWxkR2h2WkR0Y2JpQWdJQ0FnSUdOdmJuUmxlSFF1WVhKbklEMGdZWEpuTzF4dVhHNGdJQ0FnSUNCM2FHbHNaU0FvZEhKMVpTa2dlMXh1SUNBZ0lDQWdJQ0IyWVhJZ1pHVnNaV2RoZEdVZ1BTQmpiMjUwWlhoMExtUmxiR1ZuWVhSbE8xeHVJQ0FnSUNBZ0lDQnBaaUFvWkdWc1pXZGhkR1VwSUh0Y2JpQWdJQ0FnSUNBZ0lDQjJZWElnWkdWc1pXZGhkR1ZTWlhOMWJIUWdQU0J0WVhsaVpVbHVkbTlyWlVSbGJHVm5ZWFJsS0dSbGJHVm5ZWFJsTENCamIyNTBaWGgwS1R0Y2JpQWdJQ0FnSUNBZ0lDQnBaaUFvWkdWc1pXZGhkR1ZTWlhOMWJIUXBJSHRjYmlBZ0lDQWdJQ0FnSUNBZ0lHbG1JQ2hrWld4bFoyRjBaVkpsYzNWc2RDQTlQVDBnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiQ2tnWTI5dWRHbHVkV1U3WEc0Z0lDQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z1pHVnNaV2RoZEdWU1pYTjFiSFE3WEc0Z0lDQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJQ0FnYVdZZ0tHTnZiblJsZUhRdWJXVjBhRzlrSUQwOVBTQmNJbTVsZUhSY0lpa2dlMXh1SUNBZ0lDQWdJQ0FnSUM4dklGTmxkSFJwYm1jZ1kyOXVkR1Y0ZEM1ZmMyVnVkQ0JtYjNJZ2JHVm5ZV041SUhOMWNIQnZjblFnYjJZZ1FtRmlaV3duYzF4dUlDQWdJQ0FnSUNBZ0lDOHZJR1oxYm1OMGFXOXVMbk5sYm5RZ2FXMXdiR1Z0Wlc1MFlYUnBiMjR1WEc0Z0lDQWdJQ0FnSUNBZ1kyOXVkR1Y0ZEM1elpXNTBJRDBnWTI5dWRHVjRkQzVmYzJWdWRDQTlJR052Ym5SbGVIUXVZWEpuTzF4dVhHNGdJQ0FnSUNBZ0lIMGdaV3h6WlNCcFppQW9ZMjl1ZEdWNGRDNXRaWFJvYjJRZ1BUMDlJRndpZEdoeWIzZGNJaWtnZTF4dUlDQWdJQ0FnSUNBZ0lHbG1JQ2h6ZEdGMFpTQTlQVDBnUjJWdVUzUmhkR1ZUZFhOd1pXNWtaV1JUZEdGeWRDa2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ2MzUmhkR1VnUFNCSFpXNVRkR0YwWlVOdmJYQnNaWFJsWkR0Y2JpQWdJQ0FnSUNBZ0lDQWdJSFJvY205M0lHTnZiblJsZUhRdVlYSm5PMXh1SUNBZ0lDQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ0lDQWdJR052Ym5SbGVIUXVaR2x6Y0dGMFkyaEZlR05sY0hScGIyNG9ZMjl1ZEdWNGRDNWhjbWNwTzF4dVhHNGdJQ0FnSUNBZ0lIMGdaV3h6WlNCcFppQW9ZMjl1ZEdWNGRDNXRaWFJvYjJRZ1BUMDlJRndpY21WMGRYSnVYQ0lwSUh0Y2JpQWdJQ0FnSUNBZ0lDQmpiMjUwWlhoMExtRmljblZ3ZENoY0luSmxkSFZ5Ymx3aUxDQmpiMjUwWlhoMExtRnlaeWs3WEc0Z0lDQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ0lDQnpkR0YwWlNBOUlFZGxibE4wWVhSbFJYaGxZM1YwYVc1bk8xeHVYRzRnSUNBZ0lDQWdJSFpoY2lCeVpXTnZjbVFnUFNCMGNubERZWFJqYUNocGJtNWxja1p1TENCelpXeG1MQ0JqYjI1MFpYaDBLVHRjYmlBZ0lDQWdJQ0FnYVdZZ0tISmxZMjl5WkM1MGVYQmxJRDA5UFNCY0ltNXZjbTFoYkZ3aUtTQjdYRzRnSUNBZ0lDQWdJQ0FnTHk4Z1NXWWdZVzRnWlhoalpYQjBhVzl1SUdseklIUm9jbTkzYmlCbWNtOXRJR2x1Ym1WeVJtNHNJSGRsSUd4bFlYWmxJSE4wWVhSbElEMDlQVnh1SUNBZ0lDQWdJQ0FnSUM4dklFZGxibE4wWVhSbFJYaGxZM1YwYVc1bklHRnVaQ0JzYjI5d0lHSmhZMnNnWm05eUlHRnViM1JvWlhJZ2FXNTJiMk5oZEdsdmJpNWNiaUFnSUNBZ0lDQWdJQ0J6ZEdGMFpTQTlJR052Ym5SbGVIUXVaRzl1WlZ4dUlDQWdJQ0FnSUNBZ0lDQWdQeUJIWlc1VGRHRjBaVU52YlhCc1pYUmxaRnh1SUNBZ0lDQWdJQ0FnSUNBZ09pQkhaVzVUZEdGMFpWTjFjM0JsYm1SbFpGbHBaV3hrTzF4dVhHNGdJQ0FnSUNBZ0lDQWdhV1lnS0hKbFkyOXlaQzVoY21jZ1BUMDlJRU52Ym5ScGJuVmxVMlZ1ZEdsdVpXd3BJSHRjYmlBZ0lDQWdJQ0FnSUNBZ0lHTnZiblJwYm5WbE8xeHVJQ0FnSUNBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnSUNBZ0lISmxkSFZ5YmlCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0IyWVd4MVpUb2djbVZqYjNKa0xtRnlaeXhjYmlBZ0lDQWdJQ0FnSUNBZ0lHUnZibVU2SUdOdmJuUmxlSFF1Wkc5dVpWeHVJQ0FnSUNBZ0lDQWdJSDA3WEc1Y2JpQWdJQ0FnSUNBZ2ZTQmxiSE5sSUdsbUlDaHlaV052Y21RdWRIbHdaU0E5UFQwZ1hDSjBhSEp2ZDF3aUtTQjdYRzRnSUNBZ0lDQWdJQ0FnYzNSaGRHVWdQU0JIWlc1VGRHRjBaVU52YlhCc1pYUmxaRHRjYmlBZ0lDQWdJQ0FnSUNBdkx5QkVhWE53WVhSamFDQjBhR1VnWlhoalpYQjBhVzl1SUdKNUlHeHZiM0JwYm1jZ1ltRmpheUJoY205MWJtUWdkRzhnZEdobFhHNGdJQ0FnSUNBZ0lDQWdMeThnWTI5dWRHVjRkQzVrYVhOd1lYUmphRVY0WTJWd2RHbHZiaWhqYjI1MFpYaDBMbUZ5WnlrZ1kyRnNiQ0JoWW05MlpTNWNiaUFnSUNBZ0lDQWdJQ0JqYjI1MFpYaDBMbTFsZEdodlpDQTlJRndpZEdoeWIzZGNJanRjYmlBZ0lDQWdJQ0FnSUNCamIyNTBaWGgwTG1GeVp5QTlJSEpsWTI5eVpDNWhjbWM3WEc0Z0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUgxY2JpQWdJQ0I5TzF4dUlDQjlYRzVjYmlBZ0x5OGdRMkZzYkNCa1pXeGxaMkYwWlM1cGRHVnlZWFJ2Y2x0amIyNTBaWGgwTG0xbGRHaHZaRjBvWTI5dWRHVjRkQzVoY21jcElHRnVaQ0JvWVc1a2JHVWdkR2hsWEc0Z0lDOHZJSEpsYzNWc2RDd2daV2wwYUdWeUlHSjVJSEpsZEhWeWJtbHVaeUJoSUhzZ2RtRnNkV1VzSUdSdmJtVWdmU0J5WlhOMWJIUWdabkp2YlNCMGFHVmNiaUFnTHk4Z1pHVnNaV2RoZEdVZ2FYUmxjbUYwYjNJc0lHOXlJR0o1SUcxdlpHbG1lV2x1WnlCamIyNTBaWGgwTG0xbGRHaHZaQ0JoYm1RZ1kyOXVkR1Y0ZEM1aGNtY3NYRzRnSUM4dklITmxkSFJwYm1jZ1kyOXVkR1Y0ZEM1a1pXeGxaMkYwWlNCMGJ5QnVkV3hzTENCaGJtUWdjbVYwZFhKdWFXNW5JSFJvWlNCRGIyNTBhVzUxWlZObGJuUnBibVZzTGx4dUlDQm1kVzVqZEdsdmJpQnRZWGxpWlVsdWRtOXJaVVJsYkdWbllYUmxLR1JsYkdWbllYUmxMQ0JqYjI1MFpYaDBLU0I3WEc0Z0lDQWdkbUZ5SUcxbGRHaHZaQ0E5SUdSbGJHVm5ZWFJsTG1sMFpYSmhkRzl5VzJOdmJuUmxlSFF1YldWMGFHOWtYVHRjYmlBZ0lDQnBaaUFvYldWMGFHOWtJRDA5UFNCMWJtUmxabWx1WldRcElIdGNiaUFnSUNBZ0lDOHZJRUVnTG5Sb2NtOTNJRzl5SUM1eVpYUjFjbTRnZDJobGJpQjBhR1VnWkdWc1pXZGhkR1VnYVhSbGNtRjBiM0lnYUdGeklHNXZJQzUwYUhKdmQxeHVJQ0FnSUNBZ0x5OGdiV1YwYUc5a0lHRnNkMkY1Y3lCMFpYSnRhVzVoZEdWeklIUm9aU0I1YVdWc1pDb2diRzl2Y0M1Y2JpQWdJQ0FnSUdOdmJuUmxlSFF1WkdWc1pXZGhkR1VnUFNCdWRXeHNPMXh1WEc0Z0lDQWdJQ0JwWmlBb1kyOXVkR1Y0ZEM1dFpYUm9iMlFnUFQwOUlGd2lkR2h5YjNkY0lpa2dlMXh1SUNBZ0lDQWdJQ0F2THlCT2IzUmxPaUJiWENKeVpYUjFjbTVjSWwwZ2JYVnpkQ0JpWlNCMWMyVmtJR1p2Y2lCRlV6TWdjR0Z5YzJsdVp5QmpiMjF3WVhScFltbHNhWFI1TGx4dUlDQWdJQ0FnSUNCcFppQW9aR1ZzWldkaGRHVXVhWFJsY21GMGIzSmJYQ0p5WlhSMWNtNWNJbDBwSUh0Y2JpQWdJQ0FnSUNBZ0lDQXZMeUJKWmlCMGFHVWdaR1ZzWldkaGRHVWdhWFJsY21GMGIzSWdhR0Z6SUdFZ2NtVjBkWEp1SUcxbGRHaHZaQ3dnWjJsMlpTQnBkQ0JoWEc0Z0lDQWdJQ0FnSUNBZ0x5OGdZMmhoYm1ObElIUnZJR05zWldGdUlIVndMbHh1SUNBZ0lDQWdJQ0FnSUdOdmJuUmxlSFF1YldWMGFHOWtJRDBnWENKeVpYUjFjbTVjSWp0Y2JpQWdJQ0FnSUNBZ0lDQmpiMjUwWlhoMExtRnlaeUE5SUhWdVpHVm1hVzVsWkR0Y2JpQWdJQ0FnSUNBZ0lDQnRZWGxpWlVsdWRtOXJaVVJsYkdWbllYUmxLR1JsYkdWbllYUmxMQ0JqYjI1MFpYaDBLVHRjYmx4dUlDQWdJQ0FnSUNBZ0lHbG1JQ2hqYjI1MFpYaDBMbTFsZEdodlpDQTlQVDBnWENKMGFISnZkMXdpS1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0F2THlCSlppQnRZWGxpWlVsdWRtOXJaVVJsYkdWbllYUmxLR052Ym5SbGVIUXBJR05vWVc1blpXUWdZMjl1ZEdWNGRDNXRaWFJvYjJRZ1puSnZiVnh1SUNBZ0lDQWdJQ0FnSUNBZ0x5OGdYQ0p5WlhSMWNtNWNJaUIwYnlCY0luUm9jbTkzWENJc0lHeGxkQ0IwYUdGMElHOTJaWEp5YVdSbElIUm9aU0JVZVhCbFJYSnliM0lnWW1Wc2IzY3VYRzRnSUNBZ0lDQWdJQ0FnSUNCeVpYUjFjbTRnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiRHRjYmlBZ0lDQWdJQ0FnSUNCOVhHNGdJQ0FnSUNBZ0lIMWNibHh1SUNBZ0lDQWdJQ0JqYjI1MFpYaDBMbTFsZEdodlpDQTlJRndpZEdoeWIzZGNJanRjYmlBZ0lDQWdJQ0FnWTI5dWRHVjRkQzVoY21jZ1BTQnVaWGNnVkhsd1pVVnljbTl5S0Z4dUlDQWdJQ0FnSUNBZ0lGd2lWR2hsSUdsMFpYSmhkRzl5SUdSdlpYTWdibTkwSUhCeWIzWnBaR1VnWVNBbmRHaHliM2NuSUcxbGRHaHZaRndpS1R0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ2NtVjBkWEp1SUVOdmJuUnBiblZsVTJWdWRHbHVaV3c3WEc0Z0lDQWdmVnh1WEc0Z0lDQWdkbUZ5SUhKbFkyOXlaQ0E5SUhSeWVVTmhkR05vS0cxbGRHaHZaQ3dnWkdWc1pXZGhkR1V1YVhSbGNtRjBiM0lzSUdOdmJuUmxlSFF1WVhKbktUdGNibHh1SUNBZ0lHbG1JQ2h5WldOdmNtUXVkSGx3WlNBOVBUMGdYQ0owYUhKdmQxd2lLU0I3WEc0Z0lDQWdJQ0JqYjI1MFpYaDBMbTFsZEdodlpDQTlJRndpZEdoeWIzZGNJanRjYmlBZ0lDQWdJR052Ym5SbGVIUXVZWEpuSUQwZ2NtVmpiM0prTG1GeVp6dGNiaUFnSUNBZ0lHTnZiblJsZUhRdVpHVnNaV2RoZEdVZ1BTQnVkV3hzTzF4dUlDQWdJQ0FnY21WMGRYSnVJRU52Ym5ScGJuVmxVMlZ1ZEdsdVpXdzdYRzRnSUNBZ2ZWeHVYRzRnSUNBZ2RtRnlJR2x1Wm04Z1BTQnlaV052Y21RdVlYSm5PMXh1WEc0Z0lDQWdhV1lnS0NFZ2FXNW1ieWtnZTF4dUlDQWdJQ0FnWTI5dWRHVjRkQzV0WlhSb2IyUWdQU0JjSW5Sb2NtOTNYQ0k3WEc0Z0lDQWdJQ0JqYjI1MFpYaDBMbUZ5WnlBOUlHNWxkeUJVZVhCbFJYSnliM0lvWENKcGRHVnlZWFJ2Y2lCeVpYTjFiSFFnYVhNZ2JtOTBJR0Z1SUc5aWFtVmpkRndpS1R0Y2JpQWdJQ0FnSUdOdmJuUmxlSFF1WkdWc1pXZGhkR1VnUFNCdWRXeHNPMXh1SUNBZ0lDQWdjbVYwZFhKdUlFTnZiblJwYm5WbFUyVnVkR2x1Wld3N1hHNGdJQ0FnZlZ4dVhHNGdJQ0FnYVdZZ0tHbHVabTh1Wkc5dVpTa2dlMXh1SUNBZ0lDQWdMeThnUVhOemFXZHVJSFJvWlNCeVpYTjFiSFFnYjJZZ2RHaGxJR1pwYm1semFHVmtJR1JsYkdWbllYUmxJSFJ2SUhSb1pTQjBaVzF3YjNKaGNubGNiaUFnSUNBZ0lDOHZJSFpoY21saFlteGxJSE53WldOcFptbGxaQ0JpZVNCa1pXeGxaMkYwWlM1eVpYTjFiSFJPWVcxbElDaHpaV1VnWkdWc1pXZGhkR1ZaYVdWc1pDa3VYRzRnSUNBZ0lDQmpiMjUwWlhoMFcyUmxiR1ZuWVhSbExuSmxjM1ZzZEU1aGJXVmRJRDBnYVc1bWJ5NTJZV3gxWlR0Y2JseHVJQ0FnSUNBZ0x5OGdVbVZ6ZFcxbElHVjRaV04xZEdsdmJpQmhkQ0IwYUdVZ1pHVnphWEpsWkNCc2IyTmhkR2x2YmlBb2MyVmxJR1JsYkdWbllYUmxXV2xsYkdRcExseHVJQ0FnSUNBZ1kyOXVkR1Y0ZEM1dVpYaDBJRDBnWkdWc1pXZGhkR1V1Ym1WNGRFeHZZenRjYmx4dUlDQWdJQ0FnTHk4Z1NXWWdZMjl1ZEdWNGRDNXRaWFJvYjJRZ2QyRnpJRndpZEdoeWIzZGNJaUJpZFhRZ2RHaGxJR1JsYkdWbllYUmxJR2hoYm1Sc1pXUWdkR2hsWEc0Z0lDQWdJQ0F2THlCbGVHTmxjSFJwYjI0c0lHeGxkQ0IwYUdVZ2IzVjBaWElnWjJWdVpYSmhkRzl5SUhCeWIyTmxaV1FnYm05eWJXRnNiSGt1SUVsbVhHNGdJQ0FnSUNBdkx5QmpiMjUwWlhoMExtMWxkR2h2WkNCM1lYTWdYQ0p1WlhoMFhDSXNJR1p2Y21kbGRDQmpiMjUwWlhoMExtRnlaeUJ6YVc1alpTQnBkQ0JvWVhNZ1ltVmxibHh1SUNBZ0lDQWdMeThnWENKamIyNXpkVzFsWkZ3aUlHSjVJSFJvWlNCa1pXeGxaMkYwWlNCcGRHVnlZWFJ2Y2k0Z1NXWWdZMjl1ZEdWNGRDNXRaWFJvYjJRZ2QyRnpYRzRnSUNBZ0lDQXZMeUJjSW5KbGRIVnlibHdpTENCaGJHeHZkeUIwYUdVZ2IzSnBaMmx1WVd3Z0xuSmxkSFZ5YmlCallXeHNJSFJ2SUdOdmJuUnBiblZsSUdsdUlIUm9aVnh1SUNBZ0lDQWdMeThnYjNWMFpYSWdaMlZ1WlhKaGRHOXlMbHh1SUNBZ0lDQWdhV1lnS0dOdmJuUmxlSFF1YldWMGFHOWtJQ0U5UFNCY0luSmxkSFZ5Ymx3aUtTQjdYRzRnSUNBZ0lDQWdJR052Ym5SbGVIUXViV1YwYUc5a0lEMGdYQ0p1WlhoMFhDSTdYRzRnSUNBZ0lDQWdJR052Ym5SbGVIUXVZWEpuSUQwZ2RXNWtaV1pwYm1Wa08xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ2ZTQmxiSE5sSUh0Y2JpQWdJQ0FnSUM4dklGSmxMWGxwWld4a0lIUm9aU0J5WlhOMWJIUWdjbVYwZFhKdVpXUWdZbmtnZEdobElHUmxiR1ZuWVhSbElHMWxkR2h2WkM1Y2JpQWdJQ0FnSUhKbGRIVnliaUJwYm1adk8xeHVJQ0FnSUgxY2JseHVJQ0FnSUM4dklGUm9aU0JrWld4bFoyRjBaU0JwZEdWeVlYUnZjaUJwY3lCbWFXNXBjMmhsWkN3Z2MyOGdabTl5WjJWMElHbDBJR0Z1WkNCamIyNTBhVzUxWlNCM2FYUm9YRzRnSUNBZ0x5OGdkR2hsSUc5MWRHVnlJR2RsYm1WeVlYUnZjaTVjYmlBZ0lDQmpiMjUwWlhoMExtUmxiR1ZuWVhSbElEMGdiblZzYkR0Y2JpQWdJQ0J5WlhSMWNtNGdRMjl1ZEdsdWRXVlRaVzUwYVc1bGJEdGNiaUFnZlZ4dVhHNGdJQzh2SUVSbFptbHVaU0JIWlc1bGNtRjBiM0l1Y0hKdmRHOTBlWEJsTG50dVpYaDBMSFJvY205M0xISmxkSFZ5Ym4wZ2FXNGdkR1Z5YlhNZ2IyWWdkR2hsWEc0Z0lDOHZJSFZ1YVdacFpXUWdMbDlwYm5admEyVWdhR1ZzY0dWeUlHMWxkR2h2WkM1Y2JpQWdaR1ZtYVc1bFNYUmxjbUYwYjNKTlpYUm9iMlJ6S0Vkd0tUdGNibHh1SUNCSGNGdDBiMU4wY21sdVoxUmhaMU41YldKdmJGMGdQU0JjSWtkbGJtVnlZWFJ2Y2x3aU8xeHVYRzRnSUM4dklFRWdSMlZ1WlhKaGRHOXlJSE5vYjNWc1pDQmhiSGRoZVhNZ2NtVjBkWEp1SUdsMGMyVnNaaUJoY3lCMGFHVWdhWFJsY21GMGIzSWdiMkpxWldOMElIZG9aVzRnZEdobFhHNGdJQzh2SUVCQWFYUmxjbUYwYjNJZ1puVnVZM1JwYjI0Z2FYTWdZMkZzYkdWa0lHOXVJR2wwTGlCVGIyMWxJR0p5YjNkelpYSnpKeUJwYlhCc1pXMWxiblJoZEdsdmJuTWdiMllnZEdobFhHNGdJQzh2SUdsMFpYSmhkRzl5SUhCeWIzUnZkSGx3WlNCamFHRnBiaUJwYm1OdmNuSmxZM1JzZVNCcGJYQnNaVzFsYm5RZ2RHaHBjeXdnWTJGMWMybHVaeUIwYUdVZ1IyVnVaWEpoZEc5eVhHNGdJQzh2SUc5aWFtVmpkQ0IwYnlCdWIzUWdZbVVnY21WMGRYSnVaV1FnWm5KdmJTQjBhR2x6SUdOaGJHd3VJRlJvYVhNZ1pXNXpkWEpsY3lCMGFHRjBJR1J2WlhOdUozUWdhR0Z3Y0dWdUxseHVJQ0F2THlCVFpXVWdhSFIwY0hNNkx5OW5hWFJvZFdJdVkyOXRMMlpoWTJWaWIyOXJMM0psWjJWdVpYSmhkRzl5TDJsemMzVmxjeTh5TnpRZ1ptOXlJRzF2Y21VZ1pHVjBZV2xzY3k1Y2JpQWdSM0JiYVhSbGNtRjBiM0pUZVcxaWIyeGRJRDBnWm5WdVkzUnBiMjRvS1NCN1hHNGdJQ0FnY21WMGRYSnVJSFJvYVhNN1hHNGdJSDA3WEc1Y2JpQWdSM0F1ZEc5VGRISnBibWNnUFNCbWRXNWpkR2x2YmlncElIdGNiaUFnSUNCeVpYUjFjbTRnWENKYmIySnFaV04wSUVkbGJtVnlZWFJ2Y2wxY0lqdGNiaUFnZlR0Y2JseHVJQ0JtZFc1amRHbHZiaUJ3ZFhOb1ZISjVSVzUwY25rb2JHOWpjeWtnZTF4dUlDQWdJSFpoY2lCbGJuUnllU0E5SUhzZ2RISjVURzlqT2lCc2IyTnpXekJkSUgwN1hHNWNiaUFnSUNCcFppQW9NU0JwYmlCc2IyTnpLU0I3WEc0Z0lDQWdJQ0JsYm5SeWVTNWpZWFJqYUV4dll5QTlJR3h2WTNOYk1WMDdYRzRnSUNBZ2ZWeHVYRzRnSUNBZ2FXWWdLRElnYVc0Z2JHOWpjeWtnZTF4dUlDQWdJQ0FnWlc1MGNua3VabWx1WVd4c2VVeHZZeUE5SUd4dlkzTmJNbDA3WEc0Z0lDQWdJQ0JsYm5SeWVTNWhablJsY2t4dll5QTlJR3h2WTNOYk0xMDdYRzRnSUNBZ2ZWeHVYRzRnSUNBZ2RHaHBjeTUwY25sRmJuUnlhV1Z6TG5CMWMyZ29aVzUwY25rcE8xeHVJQ0I5WEc1Y2JpQWdablZ1WTNScGIyNGdjbVZ6WlhSVWNubEZiblJ5ZVNobGJuUnllU2tnZTF4dUlDQWdJSFpoY2lCeVpXTnZjbVFnUFNCbGJuUnllUzVqYjIxd2JHVjBhVzl1SUh4OElIdDlPMXh1SUNBZ0lISmxZMjl5WkM1MGVYQmxJRDBnWENKdWIzSnRZV3hjSWp0Y2JpQWdJQ0JrWld4bGRHVWdjbVZqYjNKa0xtRnlaenRjYmlBZ0lDQmxiblJ5ZVM1amIyMXdiR1YwYVc5dUlEMGdjbVZqYjNKa08xeHVJQ0I5WEc1Y2JpQWdablZ1WTNScGIyNGdRMjl1ZEdWNGRDaDBjbmxNYjJOelRHbHpkQ2tnZTF4dUlDQWdJQzh2SUZSb1pTQnliMjkwSUdWdWRISjVJRzlpYW1WamRDQW9aV1ptWldOMGFYWmxiSGtnWVNCMGNua2djM1JoZEdWdFpXNTBJSGRwZEdodmRYUWdZU0JqWVhSamFGeHVJQ0FnSUM4dklHOXlJR0VnWm1sdVlXeHNlU0JpYkc5amF5a2daMmwyWlhNZ2RYTWdZU0J3YkdGalpTQjBieUJ6ZEc5eVpTQjJZV3gxWlhNZ2RHaHliM2R1SUdaeWIyMWNiaUFnSUNBdkx5QnNiMk5oZEdsdmJuTWdkMmhsY21VZ2RHaGxjbVVnYVhNZ2JtOGdaVzVqYkc5emFXNW5JSFJ5ZVNCemRHRjBaVzFsYm5RdVhHNGdJQ0FnZEdocGN5NTBjbmxGYm5SeWFXVnpJRDBnVzNzZ2RISjVURzlqT2lCY0luSnZiM1JjSWlCOVhUdGNiaUFnSUNCMGNubE1iMk56VEdsemRDNW1iM0pGWVdOb0tIQjFjMmhVY25sRmJuUnllU3dnZEdocGN5azdYRzRnSUNBZ2RHaHBjeTV5WlhObGRDaDBjblZsS1R0Y2JpQWdmVnh1WEc0Z0lHVjRjRzl5ZEhNdWEyVjVjeUE5SUdaMWJtTjBhVzl1S0c5aWFtVmpkQ2tnZTF4dUlDQWdJSFpoY2lCclpYbHpJRDBnVzEwN1hHNGdJQ0FnWm05eUlDaDJZWElnYTJWNUlHbHVJRzlpYW1WamRDa2dlMXh1SUNBZ0lDQWdhMlY1Y3k1d2RYTm9LR3RsZVNrN1hHNGdJQ0FnZlZ4dUlDQWdJR3RsZVhNdWNtVjJaWEp6WlNncE8xeHVYRzRnSUNBZ0x5OGdVbUYwYUdWeUlIUm9ZVzRnY21WMGRYSnVhVzVuSUdGdUlHOWlhbVZqZENCM2FYUm9JR0VnYm1WNGRDQnRaWFJvYjJRc0lIZGxJR3RsWlhCY2JpQWdJQ0F2THlCMGFHbHVaM01nYzJsdGNHeGxJR0Z1WkNCeVpYUjFjbTRnZEdobElHNWxlSFFnWm5WdVkzUnBiMjRnYVhSelpXeG1MbHh1SUNBZ0lISmxkSFZ5YmlCbWRXNWpkR2x2YmlCdVpYaDBLQ2tnZTF4dUlDQWdJQ0FnZDJocGJHVWdLR3RsZVhNdWJHVnVaM1JvS1NCN1hHNGdJQ0FnSUNBZ0lIWmhjaUJyWlhrZ1BTQnJaWGx6TG5CdmNDZ3BPMXh1SUNBZ0lDQWdJQ0JwWmlBb2EyVjVJR2x1SUc5aWFtVmpkQ2tnZTF4dUlDQWdJQ0FnSUNBZ0lHNWxlSFF1ZG1Gc2RXVWdQU0JyWlhrN1hHNGdJQ0FnSUNBZ0lDQWdibVY0ZEM1a2IyNWxJRDBnWm1Gc2MyVTdYRzRnSUNBZ0lDQWdJQ0FnY21WMGRYSnVJRzVsZUhRN1hHNGdJQ0FnSUNBZ0lIMWNiaUFnSUNBZ0lIMWNibHh1SUNBZ0lDQWdMeThnVkc4Z1lYWnZhV1FnWTNKbFlYUnBibWNnWVc0Z1lXUmthWFJwYjI1aGJDQnZZbXBsWTNRc0lIZGxJR3AxYzNRZ2FHRnVaeUIwYUdVZ0xuWmhiSFZsWEc0Z0lDQWdJQ0F2THlCaGJtUWdMbVJ2Ym1VZ2NISnZjR1Z5ZEdsbGN5QnZabVlnZEdobElHNWxlSFFnWm5WdVkzUnBiMjRnYjJKcVpXTjBJR2wwYzJWc1ppNGdWR2hwYzF4dUlDQWdJQ0FnTHk4Z1lXeHpieUJsYm5OMWNtVnpJSFJvWVhRZ2RHaGxJRzFwYm1sbWFXVnlJSGRwYkd3Z2JtOTBJR0Z1YjI1NWJXbDZaU0IwYUdVZ1puVnVZM1JwYjI0dVhHNGdJQ0FnSUNCdVpYaDBMbVJ2Ym1VZ1BTQjBjblZsTzF4dUlDQWdJQ0FnY21WMGRYSnVJRzVsZUhRN1hHNGdJQ0FnZlR0Y2JpQWdmVHRjYmx4dUlDQm1kVzVqZEdsdmJpQjJZV3gxWlhNb2FYUmxjbUZpYkdVcElIdGNiaUFnSUNCcFppQW9hWFJsY21GaWJHVXBJSHRjYmlBZ0lDQWdJSFpoY2lCcGRHVnlZWFJ2Y2sxbGRHaHZaQ0E5SUdsMFpYSmhZbXhsVzJsMFpYSmhkRzl5VTNsdFltOXNYVHRjYmlBZ0lDQWdJR2xtSUNocGRHVnlZWFJ2Y2sxbGRHaHZaQ2tnZTF4dUlDQWdJQ0FnSUNCeVpYUjFjbTRnYVhSbGNtRjBiM0pOWlhSb2IyUXVZMkZzYkNocGRHVnlZV0pzWlNrN1hHNGdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lHbG1JQ2gwZVhCbGIyWWdhWFJsY21GaWJHVXVibVY0ZENBOVBUMGdYQ0ptZFc1amRHbHZibHdpS1NCN1hHNGdJQ0FnSUNBZ0lISmxkSFZ5YmlCcGRHVnlZV0pzWlR0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ2FXWWdLQ0ZwYzA1aFRpaHBkR1Z5WVdKc1pTNXNaVzVuZEdncEtTQjdYRzRnSUNBZ0lDQWdJSFpoY2lCcElEMGdMVEVzSUc1bGVIUWdQU0JtZFc1amRHbHZiaUJ1WlhoMEtDa2dlMXh1SUNBZ0lDQWdJQ0FnSUhkb2FXeGxJQ2dySzJrZ1BDQnBkR1Z5WVdKc1pTNXNaVzVuZEdncElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUdsbUlDaG9ZWE5QZDI0dVkyRnNiQ2hwZEdWeVlXSnNaU3dnYVNrcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUNBZ2JtVjRkQzUyWVd4MVpTQTlJR2wwWlhKaFlteGxXMmxkTzF4dUlDQWdJQ0FnSUNBZ0lDQWdJQ0J1WlhoMExtUnZibVVnUFNCbVlXeHpaVHRjYmlBZ0lDQWdJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlHNWxlSFE3WEc0Z0lDQWdJQ0FnSUNBZ0lDQjlYRzRnSUNBZ0lDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNBZ0lDQWdibVY0ZEM1MllXeDFaU0E5SUhWdVpHVm1hVzVsWkR0Y2JpQWdJQ0FnSUNBZ0lDQnVaWGgwTG1SdmJtVWdQU0IwY25WbE8xeHVYRzRnSUNBZ0lDQWdJQ0FnY21WMGRYSnVJRzVsZUhRN1hHNGdJQ0FnSUNBZ0lIMDdYRzVjYmlBZ0lDQWdJQ0FnY21WMGRYSnVJRzVsZUhRdWJtVjRkQ0E5SUc1bGVIUTdYRzRnSUNBZ0lDQjlYRzRnSUNBZ2ZWeHVYRzRnSUNBZ0x5OGdVbVYwZFhKdUlHRnVJR2wwWlhKaGRHOXlJSGRwZEdnZ2JtOGdkbUZzZFdWekxseHVJQ0FnSUhKbGRIVnliaUI3SUc1bGVIUTZJR1J2Ym1WU1pYTjFiSFFnZlR0Y2JpQWdmVnh1SUNCbGVIQnZjblJ6TG5aaGJIVmxjeUE5SUhaaGJIVmxjenRjYmx4dUlDQm1kVzVqZEdsdmJpQmtiMjVsVW1WemRXeDBLQ2tnZTF4dUlDQWdJSEpsZEhWeWJpQjdJSFpoYkhWbE9pQjFibVJsWm1sdVpXUXNJR1J2Ym1VNklIUnlkV1VnZlR0Y2JpQWdmVnh1WEc0Z0lFTnZiblJsZUhRdWNISnZkRzkwZVhCbElEMGdlMXh1SUNBZ0lHTnZibk4wY25WamRHOXlPaUJEYjI1MFpYaDBMRnh1WEc0Z0lDQWdjbVZ6WlhRNklHWjFibU4wYVc5dUtITnJhWEJVWlcxd1VtVnpaWFFwSUh0Y2JpQWdJQ0FnSUhSb2FYTXVjSEpsZGlBOUlEQTdYRzRnSUNBZ0lDQjBhR2x6TG01bGVIUWdQU0F3TzF4dUlDQWdJQ0FnTHk4Z1VtVnpaWFIwYVc1bklHTnZiblJsZUhRdVgzTmxiblFnWm05eUlHeGxaMkZqZVNCemRYQndiM0owSUc5bUlFSmhZbVZzSjNOY2JpQWdJQ0FnSUM4dklHWjFibU4wYVc5dUxuTmxiblFnYVcxd2JHVnRaVzUwWVhScGIyNHVYRzRnSUNBZ0lDQjBhR2x6TG5ObGJuUWdQU0IwYUdsekxsOXpaVzUwSUQwZ2RXNWtaV1pwYm1Wa08xeHVJQ0FnSUNBZ2RHaHBjeTVrYjI1bElEMGdabUZzYzJVN1hHNGdJQ0FnSUNCMGFHbHpMbVJsYkdWbllYUmxJRDBnYm5Wc2JEdGNibHh1SUNBZ0lDQWdkR2hwY3k1dFpYUm9iMlFnUFNCY0ltNWxlSFJjSWp0Y2JpQWdJQ0FnSUhSb2FYTXVZWEpuSUQwZ2RXNWtaV1pwYm1Wa08xeHVYRzRnSUNBZ0lDQjBhR2x6TG5SeWVVVnVkSEpwWlhNdVptOXlSV0ZqYUNoeVpYTmxkRlJ5ZVVWdWRISjVLVHRjYmx4dUlDQWdJQ0FnYVdZZ0tDRnphMmx3VkdWdGNGSmxjMlYwS1NCN1hHNGdJQ0FnSUNBZ0lHWnZjaUFvZG1GeUlHNWhiV1VnYVc0Z2RHaHBjeWtnZTF4dUlDQWdJQ0FnSUNBZ0lDOHZJRTV2ZENCemRYSmxJR0ZpYjNWMElIUm9aU0J2Y0hScGJXRnNJRzl5WkdWeUlHOW1JSFJvWlhObElHTnZibVJwZEdsdmJuTTZYRzRnSUNBZ0lDQWdJQ0FnYVdZZ0tHNWhiV1V1WTJoaGNrRjBLREFwSUQwOVBTQmNJblJjSWlBbUpseHVJQ0FnSUNBZ0lDQWdJQ0FnSUNCb1lYTlBkMjR1WTJGc2JDaDBhR2x6TENCdVlXMWxLU0FtSmx4dUlDQWdJQ0FnSUNBZ0lDQWdJQ0FoYVhOT1lVNG9LMjVoYldVdWMyeHBZMlVvTVNrcEtTQjdYRzRnSUNBZ0lDQWdJQ0FnSUNCMGFHbHpXMjVoYldWZElEMGdkVzVrWldacGJtVmtPMXh1SUNBZ0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ2ZWeHVJQ0FnSUgwc1hHNWNiaUFnSUNCemRHOXdPaUJtZFc1amRHbHZiaWdwSUh0Y2JpQWdJQ0FnSUhSb2FYTXVaRzl1WlNBOUlIUnlkV1U3WEc1Y2JpQWdJQ0FnSUhaaGNpQnliMjkwUlc1MGNua2dQU0IwYUdsekxuUnllVVZ1ZEhKcFpYTmJNRjA3WEc0Z0lDQWdJQ0IyWVhJZ2NtOXZkRkpsWTI5eVpDQTlJSEp2YjNSRmJuUnllUzVqYjIxd2JHVjBhVzl1TzF4dUlDQWdJQ0FnYVdZZ0tISnZiM1JTWldOdmNtUXVkSGx3WlNBOVBUMGdYQ0owYUhKdmQxd2lLU0I3WEc0Z0lDQWdJQ0FnSUhSb2NtOTNJSEp2YjNSU1pXTnZjbVF1WVhKbk8xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQnlaWFIxY200Z2RHaHBjeTV5ZG1Gc08xeHVJQ0FnSUgwc1hHNWNiaUFnSUNCa2FYTndZWFJqYUVWNFkyVndkR2x2YmpvZ1puVnVZM1JwYjI0b1pYaGpaWEIwYVc5dUtTQjdYRzRnSUNBZ0lDQnBaaUFvZEdocGN5NWtiMjVsS1NCN1hHNGdJQ0FnSUNBZ0lIUm9jbTkzSUdWNFkyVndkR2x2Ymp0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ2RtRnlJR052Ym5SbGVIUWdQU0IwYUdsek8xeHVJQ0FnSUNBZ1puVnVZM1JwYjI0Z2FHRnVaR3hsS0d4dll5d2dZMkYxWjJoMEtTQjdYRzRnSUNBZ0lDQWdJSEpsWTI5eVpDNTBlWEJsSUQwZ1hDSjBhSEp2ZDF3aU8xeHVJQ0FnSUNBZ0lDQnlaV052Y21RdVlYSm5JRDBnWlhoalpYQjBhVzl1TzF4dUlDQWdJQ0FnSUNCamIyNTBaWGgwTG01bGVIUWdQU0JzYjJNN1hHNWNiaUFnSUNBZ0lDQWdhV1lnS0dOaGRXZG9kQ2tnZTF4dUlDQWdJQ0FnSUNBZ0lDOHZJRWxtSUhSb1pTQmthWE53WVhSamFHVmtJR1Y0WTJWd2RHbHZiaUIzWVhNZ1kyRjFaMmgwSUdKNUlHRWdZMkYwWTJnZ1lteHZZMnNzWEc0Z0lDQWdJQ0FnSUNBZ0x5OGdkR2hsYmlCc1pYUWdkR2hoZENCallYUmphQ0JpYkc5amF5Qm9ZVzVrYkdVZ2RHaGxJR1Y0WTJWd2RHbHZiaUJ1YjNKdFlXeHNlUzVjYmlBZ0lDQWdJQ0FnSUNCamIyNTBaWGgwTG0xbGRHaHZaQ0E5SUZ3aWJtVjRkRndpTzF4dUlDQWdJQ0FnSUNBZ0lHTnZiblJsZUhRdVlYSm5JRDBnZFc1a1pXWnBibVZrTzF4dUlDQWdJQ0FnSUNCOVhHNWNiaUFnSUNBZ0lDQWdjbVYwZFhKdUlDRWhJR05oZFdkb2REdGNiaUFnSUNBZ0lIMWNibHh1SUNBZ0lDQWdabTl5SUNoMllYSWdhU0E5SUhSb2FYTXVkSEo1Ulc1MGNtbGxjeTVzWlc1bmRHZ2dMU0F4T3lCcElENDlJREE3SUMwdGFTa2dlMXh1SUNBZ0lDQWdJQ0IyWVhJZ1pXNTBjbmtnUFNCMGFHbHpMblJ5ZVVWdWRISnBaWE5iYVYwN1hHNGdJQ0FnSUNBZ0lIWmhjaUJ5WldOdmNtUWdQU0JsYm5SeWVTNWpiMjF3YkdWMGFXOXVPMXh1WEc0Z0lDQWdJQ0FnSUdsbUlDaGxiblJ5ZVM1MGNubE1iMk1nUFQwOUlGd2ljbTl2ZEZ3aUtTQjdYRzRnSUNBZ0lDQWdJQ0FnTHk4Z1JYaGpaWEIwYVc5dUlIUm9jbTkzYmlCdmRYUnphV1JsSUc5bUlHRnVlU0IwY25rZ1lteHZZMnNnZEdoaGRDQmpiM1ZzWkNCb1lXNWtiR1ZjYmlBZ0lDQWdJQ0FnSUNBdkx5QnBkQ3dnYzI4Z2MyVjBJSFJvWlNCamIyMXdiR1YwYVc5dUlIWmhiSFZsSUc5bUlIUm9aU0JsYm5ScGNtVWdablZ1WTNScGIyNGdkRzljYmlBZ0lDQWdJQ0FnSUNBdkx5QjBhSEp2ZHlCMGFHVWdaWGhqWlhCMGFXOXVMbHh1SUNBZ0lDQWdJQ0FnSUhKbGRIVnliaUJvWVc1a2JHVW9YQ0psYm1SY0lpazdYRzRnSUNBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnSUNCcFppQW9aVzUwY25rdWRISjVURzlqSUR3OUlIUm9hWE11Y0hKbGRpa2dlMXh1SUNBZ0lDQWdJQ0FnSUhaaGNpQm9ZWE5EWVhSamFDQTlJR2hoYzA5M2JpNWpZV3hzS0dWdWRISjVMQ0JjSW1OaGRHTm9URzlqWENJcE8xeHVJQ0FnSUNBZ0lDQWdJSFpoY2lCb1lYTkdhVzVoYkd4NUlEMGdhR0Z6VDNkdUxtTmhiR3dvWlc1MGNua3NJRndpWm1sdVlXeHNlVXh2WTF3aUtUdGNibHh1SUNBZ0lDQWdJQ0FnSUdsbUlDaG9ZWE5EWVhSamFDQW1KaUJvWVhOR2FXNWhiR3g1S1NCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0JwWmlBb2RHaHBjeTV3Y21WMklEd2daVzUwY25rdVkyRjBZMmhNYjJNcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUdoaGJtUnNaU2hsYm5SeWVTNWpZWFJqYUV4dll5d2dkSEoxWlNrN1hHNGdJQ0FnSUNBZ0lDQWdJQ0I5SUdWc2MyVWdhV1lnS0hSb2FYTXVjSEpsZGlBOElHVnVkSEo1TG1acGJtRnNiSGxNYjJNcElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUNBZ2NtVjBkWEp1SUdoaGJtUnNaU2hsYm5SeWVTNW1hVzVoYkd4NVRHOWpLVHRjYmlBZ0lDQWdJQ0FnSUNBZ0lIMWNibHh1SUNBZ0lDQWdJQ0FnSUgwZ1pXeHpaU0JwWmlBb2FHRnpRMkYwWTJncElIdGNiaUFnSUNBZ0lDQWdJQ0FnSUdsbUlDaDBhR2x6TG5CeVpYWWdQQ0JsYm5SeWVTNWpZWFJqYUV4dll5a2dlMXh1SUNBZ0lDQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z2FHRnVaR3hsS0dWdWRISjVMbU5oZEdOb1RHOWpMQ0IwY25WbEtUdGNiaUFnSUNBZ0lDQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ0lDQWdJSDBnWld4elpTQnBaaUFvYUdGelJtbHVZV3hzZVNrZ2UxeHVJQ0FnSUNBZ0lDQWdJQ0FnYVdZZ0tIUm9hWE11Y0hKbGRpQThJR1Z1ZEhKNUxtWnBibUZzYkhsTWIyTXBJSHRjYmlBZ0lDQWdJQ0FnSUNBZ0lDQWdjbVYwZFhKdUlHaGhibVJzWlNobGJuUnllUzVtYVc1aGJHeDVURzlqS1R0Y2JpQWdJQ0FnSUNBZ0lDQWdJSDFjYmx4dUlDQWdJQ0FnSUNBZ0lIMGdaV3h6WlNCN1hHNGdJQ0FnSUNBZ0lDQWdJQ0IwYUhKdmR5QnVaWGNnUlhKeWIzSW9YQ0owY25rZ2MzUmhkR1Z0Wlc1MElIZHBkR2h2ZFhRZ1kyRjBZMmdnYjNJZ1ptbHVZV3hzZVZ3aUtUdGNiaUFnSUNBZ0lDQWdJQ0I5WEc0Z0lDQWdJQ0FnSUgxY2JpQWdJQ0FnSUgxY2JpQWdJQ0I5TEZ4dVhHNGdJQ0FnWVdKeWRYQjBPaUJtZFc1amRHbHZiaWgwZVhCbExDQmhjbWNwSUh0Y2JpQWdJQ0FnSUdadmNpQW9kbUZ5SUdrZ1BTQjBhR2x6TG5SeWVVVnVkSEpwWlhNdWJHVnVaM1JvSUMwZ01Uc2dhU0ErUFNBd095QXRMV2twSUh0Y2JpQWdJQ0FnSUNBZ2RtRnlJR1Z1ZEhKNUlEMGdkR2hwY3k1MGNubEZiblJ5YVdWelcybGRPMXh1SUNBZ0lDQWdJQ0JwWmlBb1pXNTBjbmt1ZEhKNVRHOWpJRHc5SUhSb2FYTXVjSEpsZGlBbUpseHVJQ0FnSUNBZ0lDQWdJQ0FnYUdGelQzZHVMbU5oYkd3b1pXNTBjbmtzSUZ3aVptbHVZV3hzZVV4dlkxd2lLU0FtSmx4dUlDQWdJQ0FnSUNBZ0lDQWdkR2hwY3k1d2NtVjJJRHdnWlc1MGNua3VabWx1WVd4c2VVeHZZeWtnZTF4dUlDQWdJQ0FnSUNBZ0lIWmhjaUJtYVc1aGJHeDVSVzUwY25rZ1BTQmxiblJ5ZVR0Y2JpQWdJQ0FnSUNBZ0lDQmljbVZoYXp0Y2JpQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQnBaaUFvWm1sdVlXeHNlVVZ1ZEhKNUlDWW1YRzRnSUNBZ0lDQWdJQ0FnS0hSNWNHVWdQVDA5SUZ3aVluSmxZV3RjSWlCOGZGeHVJQ0FnSUNBZ0lDQWdJQ0IwZVhCbElEMDlQU0JjSW1OdmJuUnBiblZsWENJcElDWW1YRzRnSUNBZ0lDQWdJQ0FnWm1sdVlXeHNlVVZ1ZEhKNUxuUnllVXh2WXlBOFBTQmhjbWNnSmlaY2JpQWdJQ0FnSUNBZ0lDQmhjbWNnUEQwZ1ptbHVZV3hzZVVWdWRISjVMbVpwYm1Gc2JIbE1iMk1wSUh0Y2JpQWdJQ0FnSUNBZ0x5OGdTV2R1YjNKbElIUm9aU0JtYVc1aGJHeDVJR1Z1ZEhKNUlHbG1JR052Ym5SeWIyd2dhWE1nYm05MElHcDFiWEJwYm1jZ2RHOGdZVnh1SUNBZ0lDQWdJQ0F2THlCc2IyTmhkR2x2YmlCdmRYUnphV1JsSUhSb1pTQjBjbmt2WTJGMFkyZ2dZbXh2WTJzdVhHNGdJQ0FnSUNBZ0lHWnBibUZzYkhsRmJuUnllU0E5SUc1MWJHdzdYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJSFpoY2lCeVpXTnZjbVFnUFNCbWFXNWhiR3g1Ulc1MGNua2dQeUJtYVc1aGJHeDVSVzUwY25rdVkyOXRjR3hsZEdsdmJpQTZJSHQ5TzF4dUlDQWdJQ0FnY21WamIzSmtMblI1Y0dVZ1BTQjBlWEJsTzF4dUlDQWdJQ0FnY21WamIzSmtMbUZ5WnlBOUlHRnlaenRjYmx4dUlDQWdJQ0FnYVdZZ0tHWnBibUZzYkhsRmJuUnllU2tnZTF4dUlDQWdJQ0FnSUNCMGFHbHpMbTFsZEdodlpDQTlJRndpYm1WNGRGd2lPMXh1SUNBZ0lDQWdJQ0IwYUdsekxtNWxlSFFnUFNCbWFXNWhiR3g1Ulc1MGNua3VabWx1WVd4c2VVeHZZenRjYmlBZ0lDQWdJQ0FnY21WMGRYSnVJRU52Ym5ScGJuVmxVMlZ1ZEdsdVpXdzdYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJSEpsZEhWeWJpQjBhR2x6TG1OdmJYQnNaWFJsS0hKbFkyOXlaQ2s3WEc0Z0lDQWdmU3hjYmx4dUlDQWdJR052YlhCc1pYUmxPaUJtZFc1amRHbHZiaWh5WldOdmNtUXNJR0ZtZEdWeVRHOWpLU0I3WEc0Z0lDQWdJQ0JwWmlBb2NtVmpiM0prTG5SNWNHVWdQVDA5SUZ3aWRHaHliM2RjSWlrZ2UxeHVJQ0FnSUNBZ0lDQjBhSEp2ZHlCeVpXTnZjbVF1WVhKbk8xeHVJQ0FnSUNBZ2ZWeHVYRzRnSUNBZ0lDQnBaaUFvY21WamIzSmtMblI1Y0dVZ1BUMDlJRndpWW5KbFlXdGNJaUI4ZkZ4dUlDQWdJQ0FnSUNBZ0lISmxZMjl5WkM1MGVYQmxJRDA5UFNCY0ltTnZiblJwYm5WbFhDSXBJSHRjYmlBZ0lDQWdJQ0FnZEdocGN5NXVaWGgwSUQwZ2NtVmpiM0prTG1GeVp6dGNiaUFnSUNBZ0lIMGdaV3h6WlNCcFppQW9jbVZqYjNKa0xuUjVjR1VnUFQwOUlGd2ljbVYwZFhKdVhDSXBJSHRjYmlBZ0lDQWdJQ0FnZEdocGN5NXlkbUZzSUQwZ2RHaHBjeTVoY21jZ1BTQnlaV052Y21RdVlYSm5PMXh1SUNBZ0lDQWdJQ0IwYUdsekxtMWxkR2h2WkNBOUlGd2ljbVYwZFhKdVhDSTdYRzRnSUNBZ0lDQWdJSFJvYVhNdWJtVjRkQ0E5SUZ3aVpXNWtYQ0k3WEc0Z0lDQWdJQ0I5SUdWc2MyVWdhV1lnS0hKbFkyOXlaQzUwZVhCbElEMDlQU0JjSW01dmNtMWhiRndpSUNZbUlHRm1kR1Z5VEc5aktTQjdYRzRnSUNBZ0lDQWdJSFJvYVhNdWJtVjRkQ0E5SUdGbWRHVnlURzlqTzF4dUlDQWdJQ0FnZlZ4dVhHNGdJQ0FnSUNCeVpYUjFjbTRnUTI5dWRHbHVkV1ZUWlc1MGFXNWxiRHRjYmlBZ0lDQjlMRnh1WEc0Z0lDQWdabWx1YVhOb09pQm1kVzVqZEdsdmJpaG1hVzVoYkd4NVRHOWpLU0I3WEc0Z0lDQWdJQ0JtYjNJZ0tIWmhjaUJwSUQwZ2RHaHBjeTUwY25sRmJuUnlhV1Z6TG14bGJtZDBhQ0F0SURFN0lHa2dQajBnTURzZ0xTMXBLU0I3WEc0Z0lDQWdJQ0FnSUhaaGNpQmxiblJ5ZVNBOUlIUm9hWE11ZEhKNVJXNTBjbWxsYzF0cFhUdGNiaUFnSUNBZ0lDQWdhV1lnS0dWdWRISjVMbVpwYm1Gc2JIbE1iMk1nUFQwOUlHWnBibUZzYkhsTWIyTXBJSHRjYmlBZ0lDQWdJQ0FnSUNCMGFHbHpMbU52YlhCc1pYUmxLR1Z1ZEhKNUxtTnZiWEJzWlhScGIyNHNJR1Z1ZEhKNUxtRm1kR1Z5VEc5aktUdGNiaUFnSUNBZ0lDQWdJQ0J5WlhObGRGUnllVVZ1ZEhKNUtHVnVkSEo1S1R0Y2JpQWdJQ0FnSUNBZ0lDQnlaWFIxY200Z1EyOXVkR2x1ZFdWVFpXNTBhVzVsYkR0Y2JpQWdJQ0FnSUNBZ2ZWeHVJQ0FnSUNBZ2ZWeHVJQ0FnSUgwc1hHNWNiaUFnSUNCY0ltTmhkR05vWENJNklHWjFibU4wYVc5dUtIUnllVXh2WXlrZ2UxeHVJQ0FnSUNBZ1ptOXlJQ2gyWVhJZ2FTQTlJSFJvYVhNdWRISjVSVzUwY21sbGN5NXNaVzVuZEdnZ0xTQXhPeUJwSUQ0OUlEQTdJQzB0YVNrZ2UxeHVJQ0FnSUNBZ0lDQjJZWElnWlc1MGNua2dQU0IwYUdsekxuUnllVVZ1ZEhKcFpYTmJhVjA3WEc0Z0lDQWdJQ0FnSUdsbUlDaGxiblJ5ZVM1MGNubE1iMk1nUFQwOUlIUnllVXh2WXlrZ2UxeHVJQ0FnSUNBZ0lDQWdJSFpoY2lCeVpXTnZjbVFnUFNCbGJuUnllUzVqYjIxd2JHVjBhVzl1TzF4dUlDQWdJQ0FnSUNBZ0lHbG1JQ2h5WldOdmNtUXVkSGx3WlNBOVBUMGdYQ0owYUhKdmQxd2lLU0I3WEc0Z0lDQWdJQ0FnSUNBZ0lDQjJZWElnZEdoeWIzZHVJRDBnY21WamIzSmtMbUZ5Wnp0Y2JpQWdJQ0FnSUNBZ0lDQWdJSEpsYzJWMFZISjVSVzUwY25rb1pXNTBjbmtwTzF4dUlDQWdJQ0FnSUNBZ0lIMWNiaUFnSUNBZ0lDQWdJQ0J5WlhSMWNtNGdkR2h5YjNkdU8xeHVJQ0FnSUNBZ0lDQjlYRzRnSUNBZ0lDQjlYRzVjYmlBZ0lDQWdJQzh2SUZSb1pTQmpiMjUwWlhoMExtTmhkR05vSUcxbGRHaHZaQ0J0ZFhOMElHOXViSGtnWW1VZ1kyRnNiR1ZrSUhkcGRHZ2dZU0JzYjJOaGRHbHZibHh1SUNBZ0lDQWdMeThnWVhKbmRXMWxiblFnZEdoaGRDQmpiM0p5WlhOd2IyNWtjeUIwYnlCaElHdHViM2R1SUdOaGRHTm9JR0pzYjJOckxseHVJQ0FnSUNBZ2RHaHliM2NnYm1WM0lFVnljbTl5S0Z3aWFXeHNaV2RoYkNCallYUmphQ0JoZEhSbGJYQjBYQ0lwTzF4dUlDQWdJSDBzWEc1Y2JpQWdJQ0JrWld4bFoyRjBaVmxwWld4a09pQm1kVzVqZEdsdmJpaHBkR1Z5WVdKc1pTd2djbVZ6ZFd4MFRtRnRaU3dnYm1WNGRFeHZZeWtnZTF4dUlDQWdJQ0FnZEdocGN5NWtaV3hsWjJGMFpTQTlJSHRjYmlBZ0lDQWdJQ0FnYVhSbGNtRjBiM0k2SUhaaGJIVmxjeWhwZEdWeVlXSnNaU2tzWEc0Z0lDQWdJQ0FnSUhKbGMzVnNkRTVoYldVNklISmxjM1ZzZEU1aGJXVXNYRzRnSUNBZ0lDQWdJRzVsZUhSTWIyTTZJRzVsZUhSTWIyTmNiaUFnSUNBZ0lIMDdYRzVjYmlBZ0lDQWdJR2xtSUNoMGFHbHpMbTFsZEdodlpDQTlQVDBnWENKdVpYaDBYQ0lwSUh0Y2JpQWdJQ0FnSUNBZ0x5OGdSR1ZzYVdKbGNtRjBaV3g1SUdadmNtZGxkQ0IwYUdVZ2JHRnpkQ0J6Wlc1MElIWmhiSFZsSUhOdklIUm9ZWFFnZDJVZ1pHOXVKM1JjYmlBZ0lDQWdJQ0FnTHk4Z1lXTmphV1JsYm5SaGJHeDVJSEJoYzNNZ2FYUWdiMjRnZEc4Z2RHaGxJR1JsYkdWbllYUmxMbHh1SUNBZ0lDQWdJQ0IwYUdsekxtRnlaeUE5SUhWdVpHVm1hVzVsWkR0Y2JpQWdJQ0FnSUgxY2JseHVJQ0FnSUNBZ2NtVjBkWEp1SUVOdmJuUnBiblZsVTJWdWRHbHVaV3c3WEc0Z0lDQWdmVnh1SUNCOU8xeHVYRzRnSUM4dklGSmxaMkZ5Wkd4bGMzTWdiMllnZDJobGRHaGxjaUIwYUdseklITmpjbWx3ZENCcGN5QmxlR1ZqZFhScGJtY2dZWE1nWVNCRGIyMXRiMjVLVXlCdGIyUjFiR1ZjYmlBZ0x5OGdiM0lnYm05MExDQnlaWFIxY200Z2RHaGxJSEoxYm5ScGJXVWdiMkpxWldOMElITnZJSFJvWVhRZ2QyVWdZMkZ1SUdSbFkyeGhjbVVnZEdobElIWmhjbWxoWW14bFhHNGdJQzh2SUhKbFoyVnVaWEpoZEc5eVVuVnVkR2x0WlNCcGJpQjBhR1VnYjNWMFpYSWdjMk52Y0dVc0lIZG9hV05vSUdGc2JHOTNjeUIwYUdseklHMXZaSFZzWlNCMGJ5QmlaVnh1SUNBdkx5QnBibXBsWTNSbFpDQmxZWE5wYkhrZ1lua2dZR0pwYmk5eVpXZGxibVZ5WVhSdmNpQXRMV2x1WTJ4MVpHVXRjblZ1ZEdsdFpTQnpZM0pwY0hRdWFuTmdMbHh1SUNCeVpYUjFjbTRnWlhod2IzSjBjenRjYmx4dWZTaGNiaUFnTHk4Z1NXWWdkR2hwY3lCelkzSnBjSFFnYVhNZ1pYaGxZM1YwYVc1bklHRnpJR0VnUTI5dGJXOXVTbE1nYlc5a2RXeGxMQ0IxYzJVZ2JXOWtkV3hsTG1WNGNHOXlkSE5jYmlBZ0x5OGdZWE1nZEdobElISmxaMlZ1WlhKaGRHOXlVblZ1ZEdsdFpTQnVZVzFsYzNCaFkyVXVJRTkwYUdWeWQybHpaU0JqY21WaGRHVWdZU0J1WlhjZ1pXMXdkSGxjYmlBZ0x5OGdiMkpxWldOMExpQkZhWFJvWlhJZ2QyRjVMQ0IwYUdVZ2NtVnpkV3gwYVc1bklHOWlhbVZqZENCM2FXeHNJR0psSUhWelpXUWdkRzhnYVc1cGRHbGhiR2w2WlZ4dUlDQXZMeUIwYUdVZ2NtVm5aVzVsY21GMGIzSlNkVzUwYVcxbElIWmhjbWxoWW14bElHRjBJSFJvWlNCMGIzQWdiMllnZEdocGN5Qm1hV3hsTGx4dUlDQjBlWEJsYjJZZ2JXOWtkV3hsSUQwOVBTQmNJbTlpYW1WamRGd2lJRDhnYlc5a2RXeGxMbVY0Y0c5eWRITWdPaUI3ZlZ4dUtTazdYRzVjYm5SeWVTQjdYRzRnSUhKbFoyVnVaWEpoZEc5eVVuVnVkR2x0WlNBOUlISjFiblJwYldVN1hHNTlJR05oZEdOb0lDaGhZMk5wWkdWdWRHRnNVM1J5YVdOMFRXOWtaU2tnZTF4dUlDQXZMeUJVYUdseklHMXZaSFZzWlNCemFHOTFiR1FnYm05MElHSmxJSEoxYm01cGJtY2dhVzRnYzNSeWFXTjBJRzF2WkdVc0lITnZJSFJvWlNCaFltOTJaVnh1SUNBdkx5QmhjM05wWjI1dFpXNTBJSE5vYjNWc1pDQmhiSGRoZVhNZ2QyOXlheUIxYm14bGMzTWdjMjl0WlhSb2FXNW5JR2x6SUcxcGMyTnZibVpwWjNWeVpXUXVJRXAxYzNSY2JpQWdMeThnYVc0Z1kyRnpaU0J5ZFc1MGFXMWxMbXB6SUdGalkybGtaVzUwWVd4c2VTQnlkVzV6SUdsdUlITjBjbWxqZENCdGIyUmxMQ0IzWlNCallXNGdaWE5qWVhCbFhHNGdJQzh2SUhOMGNtbGpkQ0J0YjJSbElIVnphVzVuSUdFZ1oyeHZZbUZzSUVaMWJtTjBhVzl1SUdOaGJHd3VJRlJvYVhNZ1kyOTFiR1FnWTI5dVkyVnBkbUZpYkhrZ1ptRnBiRnh1SUNBdkx5QnBaaUJoSUVOdmJuUmxiblFnVTJWamRYSnBkSGtnVUc5c2FXTjVJR1p2Y21KcFpITWdkWE5wYm1jZ1JuVnVZM1JwYjI0c0lHSjFkQ0JwYmlCMGFHRjBJR05oYzJWY2JpQWdMeThnZEdobElIQnliM0JsY2lCemIyeDFkR2x2YmlCcGN5QjBieUJtYVhnZ2RHaGxJR0ZqWTJsa1pXNTBZV3dnYzNSeWFXTjBJRzF2WkdVZ2NISnZZbXhsYlM0Z1NXWmNiaUFnTHk4Z2VXOTFKM1psSUcxcGMyTnZibVpwWjNWeVpXUWdlVzkxY2lCaWRXNWtiR1Z5SUhSdklHWnZjbU5sSUhOMGNtbGpkQ0J0YjJSbElHRnVaQ0JoY0hCc2FXVmtJR0ZjYmlBZ0x5OGdRMU5RSUhSdklHWnZjbUpwWkNCR2RXNWpkR2x2Yml3Z1lXNWtJSGx2ZFNkeVpTQnViM1FnZDJsc2JHbHVaeUIwYnlCbWFYZ2daV2wwYUdWeUlHOW1JSFJvYjNObFhHNGdJQzh2SUhCeWIySnNaVzF6TENCd2JHVmhjMlVnWkdWMFlXbHNJSGx2ZFhJZ2RXNXBjWFZsSUhCeVpXUnBZMkZ0Wlc1MElHbHVJR0VnUjJsMFNIVmlJR2x6YzNWbExseHVJQ0JHZFc1amRHbHZiaWhjSW5KY0lpd2dYQ0p5WldkbGJtVnlZWFJ2Y2xKMWJuUnBiV1VnUFNCeVhDSXBLSEoxYm5ScGJXVXBPMXh1ZlZ4dUlpd2lZMjl1YzNRZ2NtVm5aVzVsY21GMGIzSlNkVzUwYVcxbElEMGdjbVZ4ZFdseVpTaGNJbkpsWjJWdVpYSmhkRzl5TFhKMWJuUnBiV1ZjSWlrN1hISmNibHh5WEc1amIyNXpkQ0IwYjNCc2FXNWxJRDBnWkc5amRXMWxiblF1Y1hWbGNubFRaV3hsWTNSdmNpaGNJaTV0Wlc1MVhDSXBPMXh5WEc1amIyNXpkQ0J0YjJKcGJHVk5aVzUxSUQwZ1pHOWpkVzFsYm5RdVoyVjBSV3hsYldWdWRFSjVTV1FvWENKdGIySnBiR1ZOWlc1MVhDSXBPMXh5WEc1amIyNXpkQ0JqYkc5elpVSjBiaUE5SUdSdlkzVnRaVzUwTG1kbGRFVnNaVzFsYm5SQ2VVbGtLRndpWTJ4dmMyVkNkRzVjSWlrN1hISmNibU52Ym5OMElHSjFjbWRsY2lBOUlHUnZZM1Z0Wlc1MExtZGxkRVZzWlcxbGJuUkNlVWxrS0Z3aVluVnlaMlZ5WENJcE8xeHlYRzVqYjI1emRDQnRiMkpwYkdWTWFYTjBJRDBnWkc5amRXMWxiblF1WjJWMFJXeGxiV1Z1ZEVKNVNXUW9YQ0p0YjJKcGJHVk1hWE4wWENJcE8xeHlYRzVqYjI1emRDQnpaV1ZOYjNKbElEMGdaRzlqZFcxbGJuUXVaMlYwUld4bGJXVnVkRUo1U1dRb1hDSnpaV1ZOYjNKbFhDSXBPMXh5WEc1c1pYUWdZMjkxYm5SbGNpQTlJRE03WEhKY2JtTnZibk4wSUhCeWIyUjFZM1J6SUQwZ1cxeHlYRzRnSUh0Y2NseHVJQ0FnSUhOeVl6b2dYQ0pwYldjdlRXRnpheUJIY205MWNDNXFjR2RjSWl4Y2NseHVJQ0FnSUhOMVluUnBkR3hsT2lCY0lrbHVaRzl2Y2lCbGJtVnlaM2tnYzJWeWRtbGpaWE5jSWl4Y2NseHVJQ0FnSUhSbGVIUTZYSEpjYmlBZ0lDQWdJRndpVjJVZ2FHVnNjR1ZrSUVsdVpHOXZjaUJsYm1WeVoza2djMlZ5ZG1salpYTWdkRzhnWjNKbFlYUjVJSE5wYlhCc2FXWjVJSFJvWldseUlHTmhjMlVnYldGdVlXZGxiV1Z1ZENCemVYTjBaVzB1TGk1Y0lseHlYRzRnSUgwc1hISmNiaUFnZTF4eVhHNGdJQ0FnYzNKak9pQmNJbWx0Wnk5TllYTnJJRWR5YjNWd0lDZ3hLUzVxY0dkY0lpeGNjbHh1SUNBZ0lITjFZblJwZEd4bE9pQmNJa0pwY21ScFpTQkhiMnhrSUZSdmRYSnpYQ0lzWEhKY2JpQWdJQ0IwWlhoME9seHlYRzRnSUNBZ0lDQmNJbGRsSUdobGJIQmxaQ0JDYVhKa2VTQkhiMnhtSUZSdmRYSnpJSFJ2SUhOMFlYa2djbVZzWlhabFlXNTBJRzl1SUdGdUlHbHVZMnh5WldGemFXNW5iSGtnWTI5dGNHVjBhWFJwZG1VZ2JXRnlhMlYwTGk0dVhDSmNjbHh1SUNCOUxGeHlYRzRnSUh0Y2NseHVJQ0FnSUhOeVl6b2dYQ0pwYldjdlRXRnpheUJIY205MWNDQW9NaWt1YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pPYjNkWGFHVnlaVndpTEZ4eVhHNGdJQ0FnZEdWNGREcGNjbHh1SUNBZ0lDQWdYQ0pYWlNCaWRXbHNkQ0JoSUhKbFkyOXRiV1Z1WkdGMGFXOXVjeUJoY0hBZ1ptOXlJSEJsYjNCc1pTQjNiM0pyYVc1bklHbHVJR055WldGMGFYWmxJR2x1WkhWemRISnBaWE11TGk1Y0lseHlYRzRnSUgwc1hISmNiaUFnZTF4eVhHNGdJQ0FnYzNKak9pQmNJbWx0Wnk5TllYTnJJRWR5YjNWd0lDZ3pLUzVxY0dkY0lpeGNjbHh1SUNBZ0lITjFZblJwZEd4bE9pQmNJa1o1Ym1ScGNYTjJZV3B3Wlc1Y0lpeGNjbHh1SUNBZ0lIUmxlSFE2WEhKY2JpQWdJQ0FnSUZ3aVYyVWdZM0psWVhSbFpDQmhiaUJoY0hBZ2RHaGhkQ0JvWld4d1pXUWdZM1Z6ZEc5dFpYSnpJR1pwYm1RZ1oybG1kSE1nWVcxdmJtY2diVzl5WlNCMGFHRnVJREk1TURBd01EQWdhWFJsYlhNdUxpNWNJbHh5WEc0Z0lIMHNYSEpjYmlBZ2UxeHlYRzRnSUNBZ2MzSmpPaUJjSW1sdFp5OU5ZWE5ySUVkeWIzVndJQ2cwS1M1cWNHZGNJaXhjY2x4dUlDQWdJSE4xWW5ScGRHeGxPaUJjSWtKNWRHaHFkV3hjSWl4Y2NseHVJQ0FnSUhSbGVIUTZYSEpjYmlBZ0lDQWdJRndpVjJVZ1kzSmxZWFJsWkNCMGFYSmxJR1poYzJocGIyNGdabTl5SUhSb1pTQnBibU55WldGemFXNW5iSGtnWldkaGJHbDBZWEpwWVc0Z1kyRnlJRzFoYVc1MGFXNWhZMlVnYldGeWEyVjBMaTR1WENKY2NseHVJQ0I5TEZ4eVhHNGdJSHRjY2x4dUlDQWdJSE55WXpvZ1hDSnBiV2N2VFdGemF5QkhjbTkxY0NBb05Ta3VhbkJuWENJc1hISmNiaUFnSUNCemRXSjBhWFJzWlRvZ1hDSlVhV05yYVc1Y0lpeGNjbHh1SUNBZ0lIUmxlSFE2WEhKY2JpQWdJQ0FnSUZ3aVYyVWdhVzUyWlc1MFpXUWdZU0IwYVcxbElISmxjRzl5ZEdsdVp5QnplWE4wWlcwZ1ptOXlJSEJsYjNCc1pTQjNhRzhnYUdGMFpTQjBhVzFsSUhSeVlXTnJhVzVuTGk0dVhDSmNjbHh1SUNCOUxGeHlYRzRnSUh0Y2NseHVJQ0FnSUhOeVl6b2dYQ0pwYldjdlRXRnpheUJIY205MWNDQW9OaWt1YW5CblhDSXNYSEpjYmlBZ0lDQnpkV0owYVhSc1pUb2dYQ0pWWW1WeWJXVmtjMXdpTEZ4eVhHNGdJQ0FnZEdWNGREcGNjbHh1SUNBZ0lDQWdYQ0pYWlNCamNtVmhkR1ZrSUdGdUlHRndjQ0IwYUdGMElHaGxiSEJsWkNCamRYTjBiMjFsY25NZ1ptbHVaQ0JuYVdaMGN5QmhiVzl1WnlCdGIzSmxJSFJvWVc0Z01qa3dNREF3TUNCcGRHVnRjeTR1TGx3aVhISmNiaUFnZlN4Y2NseHVJQ0I3WEhKY2JpQWdJQ0J6Y21NNklGd2lhVzFuTDAxaGMyc2dSM0p2ZFhBZ0tEY3BMbXB3WjF3aUxGeHlYRzRnSUNBZ2MzVmlkR2wwYkdVNklGd2lWc09rYzNSMGNtRm1hV3NnUTJGc1kzVnNZWFJ2Y2x3aUxGeHlYRzRnSUNBZ2RHVjRkRHBjY2x4dUlDQWdJQ0FnWENKWFpTQmpjbVZoZEdWa0lIUnBjbVVnWm1GemFHbHZiaUJtYjNJZ2RHaGxJR2x1WTNKbFlYTnBibWRzZVNCbFoyRnNhWFJoY21saGJpQmpZWElnYldGcGJuUnBibUZqWlNCdFlYSnJaWFF1TGk1Y0lseHlYRzRnSUgwc1hISmNiaUFnZTF4eVhHNGdJQ0FnYzNKak9pQmNJbWx0Wnk5TllYTnJJRWR5YjNWd0lDZzRLUzVxY0dkY0lpeGNjbHh1SUNBZ0lITjFZblJwZEd4bE9pQmNJbFJ5dzZSdWFXNW5jM0JoY25SdVpYSmNJaXhjY2x4dUlDQWdJSFJsZUhRNlhISmNiaUFnSUNBZ0lGd2lWMlVnYVc1MlpXNTBaV1FnWVNCMGFXMWxJSEpsY0c5eWRHbHVaeUJ6ZVhOMFpXMGdabTl5SUhCbGIzQnNaU0IzYUc4Z2FHRjBaU0IwYVcxbElIUnlZV05yYVc1bkxpNHVYQ0pjY2x4dUlDQjlYSEpjYmwwN1hISmNibHh5WEc1a2IyTjFiV1Z1ZEM1aFpHUkZkbVZ1ZEV4cGMzUmxibVZ5S0Z3aWMyTnliMnhzWENJc0lDZ3BJRDArSUh0Y2NseHVJQ0JwWmlBb2QybHVaRzkzTG5CaFoyVlpUMlptYzJWMElEd2dkRzl3YkdsdVpTNWpiR2xsYm5SSVpXbG5hSFFwSUh0Y2NseHVJQ0FnSUhSdmNHeHBibVV1WTJ4aGMzTk1hWE4wTG5KbGJXOTJaU2hjSW1acGVHVmtYQ0lwTzF4eVhHNGdJSDBnWld4elpTQjdYSEpjYmlBZ0lDQjBiM0JzYVc1bExtTnNZWE56VEdsemRDNWhaR1FvWENKbWFYaGxaRndpS1R0Y2NseHVJQ0I5WEhKY2JuMHBPMXh5WEc1Y2NseHVZblZ5WjJWeUxtOXVZMnhwWTJzZ1BTQmxJRDArSUh0Y2NseHVJQ0JsTG5CeVpYWmxiblJFWldaaGRXeDBLQ2s3WEhKY2JpQWdiVzlpYVd4bFRXVnVkUzVqYkdGemMweHBjM1F1ZEc5bloyeGxLRndpYUdsa1pWd2lLVHRjY2x4dWZUdGNjbHh1WEhKY2JtTnNiM05sUW5SdUxtOXVZMnhwWTJzZ1BTQmxJRDArSUh0Y2NseHVJQ0JsTG5CeVpYWmxiblJFWldaaGRXeDBLQ2s3WEhKY2JpQWdiVzlpYVd4bFRXVnVkUzVqYkdGemMweHBjM1F1ZEc5bloyeGxLRndpYUdsa1pWd2lLVHRjY2x4dWZUdGNjbHh1WEhKY2JtMXZZbWxzWlV4cGMzUXViMjVqYkdsamF5QTlJQ2dwSUQwK0lIdGNjbHh1SUNCdGIySnBiR1ZOWlc1MUxtTnNZWE56VEdsemRDNTBiMmRuYkdVb1hDSm9hV1JsWENJcE8xeHlYRzU5TzF4eVhHNWNjbHh1WEhKY2JseHlYRzVqYjI1emRDQnlaVzVrWlhKUWNtOWtkV04wY3lBOUlHbDBaVzBnUFQ0Z2UxeHlYRzRnSUhKbGRIVnliaUJnUEdScGRpQmpiR0Z6Y3oxY0ltTnZiQzB4TWlCamIyd3RiV1F0TmlCamIyd3RiR2N0TkZ3aVBseHlYRzRnSUR4a2FYWWdZMnhoYzNNOVhDSndjbTlxWldOMGMxOWZZMkZ5WkZ3aVBseHlYRzRnSUNBZ1BHbHRaeUJ6Y21NOVhDSWtlMmwwWlcwdWMzSmpmVndpSUdGc2REMWNJbTFoYzJ0Y0lqNWNjbHh1SUNBZ0lEeGthWFlnWTJ4aGMzTTlYQ0p3Y205cVpXTjBjMTlmYVc1bWIxd2lQbHh5WEc0Z0lDQWdJQ0E4YURRZ1kyeGhjM005WENKd2NtOXFaV04wYzE5ZmMzVmlkR2wwYkdWY0lqNGtlMmwwWlcwdWMzVmlkR2wwYkdWOVBDOW9ORDVjY2x4dUlDQWdJQ0FnUEhBZ1kyeGhjM005WENKd2NtOXFaV04wYzE5ZmRHVjRkRndpUGlSN2FYUmxiUzUwWlhoMGZUd3ZjRDVjY2x4dUlDQWdJRHd2WkdsMlBseHlYRzRnSUR3dlpHbDJQbHh5WEc0OEwyUnBkajVnTzF4eVhHNTlPMXh5WEc1Y2NseHViR1YwSUhKbGJtUmxjbE5sWTNScGIyNGdQU0J3Y205cVpXTjBjMFJoZEdFZ1BUNGdlMXh5WEc0Z0lHTnZibk4wSUhCeWIycGxZM1J6SUQwZ0lIQnliMnBsWTNSelJHRjBZUzV0WVhBb1pXeGxiV1Z1ZENBOVBpQnlaVzVrWlhKUWNtOWtkV04wY3lobGJHVnRaVzUwS1NrN1hISmNiaUFnWkc5amRXMWxiblF1WjJWMFJXeGxiV1Z1ZEVKNVNXUW9YQ0p3Y205cVpXTjBjMUpsYm1SbGNsd2lLUzVwYm01bGNraFVUVXdnUFNCd2NtOXFaV04wY3k1cWIybHVLRndpWENJcE8xeHlYRzU5TzF4eVhHNWNjbHh1YzJWbFRXOXlaUzV2Ym1Oc2FXTnJJRDBnWlNBOVBpQjdYSEpjYmlBZ1pTNXdjbVYyWlc1MFJHVm1ZWFZzZENncE8xeHlYRzRnSUdOdmRXNTBaWElnS3owZ016dGNjbHh1SUNCeVpXNWtaWEpUWldOMGFXOXVLSEJ5YjJSMVkzUnpMbk5zYVdObEtEQXNJR052ZFc1MFpYSXBLVnh5WEc1OVhISmNibHh5WEc1M2FXNWtiM2N1WVdSa1JYWmxiblJNYVhOMFpXNWxjaWhjSWtSUFRVTnZiblJsYm5STWIyRmtaV1JjSWl3Z0tDa2dQVDRnZTF4eVhHNGdJR052Ym5OMElIZHBkR1JvUTI5MWJuUmxjaUE5SUdGemVXNWpJQ2dwSUQwK0lIdGNjbHh1SUNBZ0lITjNhWFJqYUNBb2RISjFaU2tnZTF4eVhHNGdJQ0FnSUNCallYTmxJR1J2WTNWdFpXNTBMbVJ2WTNWdFpXNTBSV3hsYldWdWRDNWpiR2xsYm5SWGFXUjBhQ0ErSURjMk9EcGNjbHh1SUNBZ0lDQWdJQ0JqYjNWdWRHVnlJRDBnT1R0Y2NseHVJQ0FnSUNBZ0lDQmljbVZoYXp0Y2NseHVJQ0FnSUNBZ1pHVm1ZWFZzZERwY2NseHVJQ0FnSUNBZ0lDQmpiM1Z1ZEdWeUlEMGdNenRjY2x4dUlDQWdJQ0FnSUNCaWNtVmhhenRjY2x4dUlDQWdJSDFjY2x4dUlDQjlPMXh5WEc0Z0lIZHBkR1JvUTI5MWJuUmxjaWdwTzF4eVhHNGdJSEpsYm1SbGNsTmxZM1JwYjI0b2NISnZaSFZqZEhNdWMyeHBZMlVvTUN3Z1kyOTFiblJsY2lrcFhISmNibjBwSWwxOSJ9
